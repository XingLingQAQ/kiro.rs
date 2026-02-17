# 错误处理改进总结

## 改进日期
2026-02-17

## 问题背景

从服务器日志中发现两类错误：

1. **空消息内容导致 400 Bad Request**
   - 日志：`"content":""`，上游返回 `{"message":"Improperly formed request.","reason":null}`
   - 根因：未在转换前验证消息内容是否为空

2. **Prefill 处理后消息列表为空**
   - 日志：检测到 prefill 并丢弃后，最后一条 user 消息也为空，导致 `消息列表为空` 错误
   - 根因：prefill 处理逻辑未验证回退后的消息内容有效性

3. **错误分类不准确**
   - 问题：`is_input_too_long_error` 函数错误地将 "Improperly formed request" 归类为"上下文过长"错误
   - 影响：所有格式错误都被误报为上下文过长，误导用户

## 实施的改进

### 1. 修复错误分类逻辑 (`src/anthropic/handlers.rs`)

**修改前：**
```rust
fn is_input_too_long_error(err: &Error) -> bool {
    let s = err.to_string();
    s.contains("CONTENT_LENGTH_EXCEEDS_THRESHOLD")
        || s.contains("Input is too long")
        || s.contains("Improperly formed request")  // ❌ 错误包含
}
```

**修改后：**
```rust
fn is_input_too_long_error(err: &Error) -> bool {
    let s = err.to_string();
    s.contains("CONTENT_LENGTH_EXCEEDS_THRESHOLD") || s.contains("Input is too long")
    // 移除 "Improperly formed request"，该错误由格式问题引起，非上下文过长
}

fn is_improperly_formed_request_error(err: &Error) -> bool {
    let s = err.to_string();
    s.contains("Improperly formed request")
}
```

**新增错误映射：**
```rust
if is_improperly_formed_request_error(&err) {
    tracing::warn!(
        error = %err,
        "上游拒绝请求：请求格式错误（可能是空消息内容或其他格式问题）"
    );
    return (
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse::new(
            "invalid_request_error",
            "Improperly formed request. Check message content is not empty and request format is valid.",
        )),
    )
        .into_response();
}
```

### 2. 添加空消息内容验证 (`src/anthropic/converter.rs`)

**新增错误类型：**
```rust
pub enum ConversionError {
    UnsupportedModel(String),
    EmptyMessages,
    EmptyMessageContent,  // ✨ 新增
}
```

**在 `convert_request` 函数中添加验证逻辑：**
```rust
// 2.6. 验证最后一条消息内容不为空
// 检查最后一条消息（经过 prefill 处理后）是否有有效内容
let last_message = messages.last().unwrap();
let has_valid_content = match &last_message.content {
    serde_json::Value::String(s) => !s.trim().is_empty(),
    serde_json::Value::Array(arr) => arr.iter().any(|item| {
        if let Ok(block) = serde_json::from_value::<ContentBlock>(item.clone()) {
            match block.block_type.as_str() {
                "text" => block.text.as_ref().is_some_and(|t| !t.trim().is_empty()),
                "image" | "tool_use" | "tool_result" => true,
                _ => false,
            }
        } else {
            false
        }
    }),
    _ => false,
};
if !has_valid_content {
    tracing::warn!("最后一条消息内容为空（仅包含空白文本或无内容）");
    return Err(ConversionError::EmptyMessageContent);
}
```

**验证时机：**
- 在 prefill 处理之后立即验证
- 确保回退到的 user 消息有有效内容
- 支持字符串和数组两种 content 格式

### 3. 更新错误处理器 (`src/anthropic/handlers.rs`)

在两处 match 语句中添加对 `EmptyMessageContent` 的处理：

```rust
let (error_type, message) = match &e {
    ConversionError::UnsupportedModel(model) => {
        ("invalid_request_error", format!("模型不支持: {}", model))
    }
    ConversionError::EmptyMessages => {
        ("invalid_request_error", "消息列表为空".to_string())
    }
    ConversionError::EmptyMessageContent => {  // ✨ 新增
        ("invalid_request_error", "消息内容为空".to_string())
    }
};
```

### 4. 添加测试用例

新增 3 个测试用例验证改进功能：

1. **`test_convert_request_empty_message_content`**
   - 测试空字符串消息内容
   - 预期：返回 `EmptyMessageContent` 错误

2. **`test_convert_request_empty_text_block`**
   - 测试仅包含空白字符的文本块
   - 预期：返回 `EmptyMessageContent` 错误

3. **`test_convert_request_prefill_with_empty_user_message`**
   - 测试 prefill 场景下，回退后的 user 消息为空
   - 预期：返回 `EmptyMessageContent` 错误

## 测试结果

```bash
$ cargo test
...
test result: ok. 286 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

所有测试通过，包括新增的 3 个测试用例。

## 影响范围

### 修改的文件
1. `src/anthropic/handlers.rs` - 错误分类和映射逻辑
2. `src/anthropic/converter.rs` - 消息内容验证逻辑

### API 行为变化
- **空消息内容**：现在会在转换阶段被拦截，返回 400 错误，错误消息为"消息内容为空"
- **Prefill 空消息**：prefill 处理后如果 user 消息为空，会返回 400 错误
- **格式错误分类**：`Improperly formed request` 错误不再被误报为"上下文过长"

### 向后兼容性
- ✅ 完全向后兼容
- ✅ 仅增强了错误检测和分类，不影响正常请求
- ✅ 所有现有测试通过

## 预期效果

1. **提前拦截无效请求**
   - 空消息内容在本地验证阶段被拦截
   - 避免向上游发送无效请求
   - 减少不必要的 API 调用

2. **更准确的错误提示**
   - "Improperly formed request" 不再被误报为"上下文过长"
   - 用户能获得更准确的错误原因
   - 便于快速定位和修复问题

3. **改进 Prefill 处理**
   - prefill 处理后验证消息有效性
   - 避免空消息列表错误
   - 提供更清晰的错误信息

## 验证方法

使用提供的测试脚本验证改进：

```bash
# 启动服务
cargo run -- -c config.json --credentials credentials.json

# 运行测试脚本
python3 tools/test_empty_content.py
```

测试脚本会验证：
- 空消息内容返回 400 错误
- 空白文本块返回 400 错误
- Prefill 空消息返回 400 错误
- 正常消息处理成功
