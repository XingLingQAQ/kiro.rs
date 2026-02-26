.PHONY: dev build release clean test lint fmt ui ui-dev docker help

# 默认目标
help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "开发:"
	@echo "  dev        cargo run（debug 模式，需先 make ui）"
	@echo "  ui-dev     启动前端 dev server"
	@echo ""
	@echo "构建:"
	@echo "  ui         构建前端"
	@echo "  build      构建前端 + 后端（debug）"
	@echo "  release    构建前端 + 后端（release）"
	@echo "  docker     构建 Docker 镜像"
	@echo ""
	@echo "质量:"
	@echo "  test       运行测试"
	@echo "  lint       cargo clippy"
	@echo "  fmt        cargo fmt"
	@echo "  check      fmt + clippy + test"
	@echo ""
	@echo "其他:"
	@echo "  clean      清理构建产物"

# --- 前端 ---

ui:
	cd admin-ui && pnpm install && pnpm build

ui-dev:
	@echo "启动前端 dev server: http://localhost:5173"
	cd admin-ui && pnpm install && pnpm dev

# --- 后端 ---

dev: ui
	cargo run --features sensitive-logs -- -c config/config.json --credentials config/credentials.json

build: ui
	cargo build

release: ui
	cargo build --release

# --- 质量 ---

test:
	cargo test

lint:
	cargo clippy -- -D warnings

fmt:
	cargo fmt

check: fmt lint test

# --- Docker ---

docker:
	docker build -t kiro-rs .

# --- 清理 ---

clean:
	cargo clean
	rm -rf admin-ui/dist admin-ui/node_modules
