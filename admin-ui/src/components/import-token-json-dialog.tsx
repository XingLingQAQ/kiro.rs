import { useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { Upload, FileJson, CheckCircle2, XCircle, AlertCircle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useImportTokenJson } from '@/hooks/use-credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { TokenJsonItem, ImportItemResult, ImportSummary } from '@/types/api'

interface ImportTokenJsonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Step = 'input' | 'preview' | 'result'

export function ImportTokenJsonDialog({ open, onOpenChange }: ImportTokenJsonDialogProps) {
  const [step, setStep] = useState<Step>('input')
  const [jsonText, setJsonText] = useState('')
  const [parsedItems, setParsedItems] = useState<TokenJsonItem[]>([])
  const [previewResults, setPreviewResults] = useState<ImportItemResult[]>([])
  const [previewSummary, setPreviewSummary] = useState<ImportSummary | null>(null)
  const [finalResults, setFinalResults] = useState<ImportItemResult[]>([])
  const [finalSummary, setFinalSummary] = useState<ImportSummary | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { mutate: importMutate, isPending } = useImportTokenJson()

  const resetState = useCallback(() => {
    setStep('input')
    setJsonText('')
    setParsedItems([])
    setPreviewResults([])
    setPreviewSummary(null)
    setFinalResults([])
    setFinalSummary(null)
  }, [])

  const handleClose = useCallback(() => {
    onOpenChange(false)
    // Delay reset to allow dialog close animation
    setTimeout(resetState, 200)
  }, [onOpenChange, resetState])

  // Parse JSON and validate
  const parseJson = useCallback((text: string): TokenJsonItem[] | null => {
    try {
      const parsed = JSON.parse(text)
      // Support both single object and array
      const items = Array.isArray(parsed) ? parsed : [parsed]
      // Basic validation: must have refreshToken
      const validItems = items.filter(
        (item) => item && typeof item === 'object' && item.refreshToken
      )
      if (validItems.length === 0) {
        toast.error('JSON 中没有找到有效的凭据（需要包含 refreshToken 字段）')
        return null
      }
      return validItems
    } catch {
      toast.error('JSON 格式无效')
      return null
    }
  }, [])

  // Handle file drop
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)

      const file = e.dataTransfer.files[0]
      if (!file) return

      if (!file.name.endsWith('.json')) {
        toast.error('请上传 JSON 文件')
        return
      }

      const reader = new FileReader()
      reader.onload = (event) => {
        const text = event.target?.result as string
        setJsonText(text)
      }
      reader.readAsText(file)
    },
    []
  )

  // Handle file select
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target?.result as string
      setJsonText(text)
    }
    reader.readAsText(file)
  }, [])

  // Preview (dry-run)
  const handlePreview = useCallback(() => {
    const items = parseJson(jsonText)
    if (!items) return

    setParsedItems(items)

    importMutate(
      { dryRun: true, items },
      {
        onSuccess: (response) => {
          setPreviewResults(response.items)
          setPreviewSummary(response.summary)
          setStep('preview')
        },
        onError: (error) => {
          toast.error(`预览失败: ${extractErrorMessage(error)}`)
        },
      }
    )
  }, [jsonText, parseJson, importMutate])

  // Confirm import
  const handleConfirmImport = useCallback(() => {
    importMutate(
      { dryRun: false, items: parsedItems },
      {
        onSuccess: (response) => {
          setFinalResults(response.items)
          setFinalSummary(response.summary)
          setStep('result')
          if (response.summary.added > 0) {
            toast.success(`成功导入 ${response.summary.added} 个凭据`)
          }
        },
        onError: (error) => {
          toast.error(`导入失败: ${extractErrorMessage(error)}`)
        },
      }
    )
  }, [parsedItems, importMutate])

  // Render action icon
  const renderActionIcon = (action: string) => {
    switch (action) {
      case 'added':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />
      case 'skipped':
        return <AlertCircle className="h-4 w-4 text-yellow-500" />
      case 'invalid':
        return <XCircle className="h-4 w-4 text-red-500" />
      default:
        return null
    }
  }

  // Render action text
  const renderActionText = (action: string) => {
    switch (action) {
      case 'added':
        return <span className="text-green-600">添加</span>
      case 'skipped':
        return <span className="text-yellow-600">跳过</span>
      case 'invalid':
        return <span className="text-red-600">无效</span>
      default:
        return action
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="h-5 w-5" />
            导入 token.json
          </DialogTitle>
          <DialogDescription>
            {step === 'input' && '粘贴或上传 token.json 文件以批量导入凭据'}
            {step === 'preview' && '预览导入结果，确认后执行导入'}
            {step === 'result' && '导入完成'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto py-4">
          {/* Step 1: Input */}
          {step === 'input' && (
            <div className="space-y-4">
              {/* Drop zone */}
              <div
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                  isDragging
                    ? 'border-primary bg-primary/5'
                    : 'border-muted-foreground/25 hover:border-muted-foreground/50'
                }`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setIsDragging(true)
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-10 w-10 mx-auto mb-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground mb-2">
                  拖放 JSON 文件到此处，或点击选择文件
                </p>
                <p className="text-xs text-muted-foreground">
                  支持单个凭据或凭据数组格式
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleFileSelect}
                />
              </div>

              {/* Or divider */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">或</span>
                </div>
              </div>

              {/* Text area */}
              <div className="space-y-2">
                <label className="text-sm font-medium">直接粘贴 JSON</label>
                <textarea
                  className="w-full h-48 p-3 text-sm font-mono border rounded-md bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder='{"refreshToken": "...", "provider": "BuilderId", ...}'
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Step 2: Preview */}
          {step === 'preview' && previewSummary && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="grid grid-cols-4 gap-4">
                <div className="text-center p-3 bg-muted rounded-lg">
                  <div className="text-2xl font-bold">{previewSummary.parsed}</div>
                  <div className="text-xs text-muted-foreground">解析</div>
                </div>
                <div className="text-center p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                  <div className="text-2xl font-bold text-green-600">{previewSummary.added}</div>
                  <div className="text-xs text-muted-foreground">将添加</div>
                </div>
                <div className="text-center p-3 bg-yellow-50 dark:bg-yellow-950 rounded-lg">
                  <div className="text-2xl font-bold text-yellow-600">{previewSummary.skipped}</div>
                  <div className="text-xs text-muted-foreground">跳过</div>
                </div>
                <div className="text-center p-3 bg-red-50 dark:bg-red-950 rounded-lg">
                  <div className="text-2xl font-bold text-red-600">{previewSummary.invalid}</div>
                  <div className="text-xs text-muted-foreground">无效</div>
                </div>
              </div>

              {/* Results list */}
              <div className="border rounded-lg overflow-hidden">
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="text-left p-2 font-medium">#</th>
                        <th className="text-left p-2 font-medium">指纹</th>
                        <th className="text-left p-2 font-medium">状态</th>
                        <th className="text-left p-2 font-medium">原因</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewResults.map((item) => (
                        <tr key={item.index} className="border-t">
                          <td className="p-2">{item.index + 1}</td>
                          <td className="p-2 font-mono text-xs">{item.fingerprint}</td>
                          <td className="p-2">
                            <div className="flex items-center gap-1">
                              {renderActionIcon(item.action)}
                              {renderActionText(item.action)}
                            </div>
                          </td>
                          <td className="p-2 text-muted-foreground text-xs">
                            {item.reason || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Result */}
          {step === 'result' && finalSummary && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="grid grid-cols-4 gap-4">
                <div className="text-center p-3 bg-muted rounded-lg">
                  <div className="text-2xl font-bold">{finalSummary.parsed}</div>
                  <div className="text-xs text-muted-foreground">解析</div>
                </div>
                <div className="text-center p-3 bg-green-50 dark:bg-green-950 rounded-lg">
                  <div className="text-2xl font-bold text-green-600">{finalSummary.added}</div>
                  <div className="text-xs text-muted-foreground">已添加</div>
                </div>
                <div className="text-center p-3 bg-yellow-50 dark:bg-yellow-950 rounded-lg">
                  <div className="text-2xl font-bold text-yellow-600">{finalSummary.skipped}</div>
                  <div className="text-xs text-muted-foreground">跳过</div>
                </div>
                <div className="text-center p-3 bg-red-50 dark:bg-red-950 rounded-lg">
                  <div className="text-2xl font-bold text-red-600">{finalSummary.invalid}</div>
                  <div className="text-xs text-muted-foreground">无效</div>
                </div>
              </div>

              {/* Results list */}
              <div className="border rounded-lg overflow-hidden">
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted sticky top-0">
                      <tr>
                        <th className="text-left p-2 font-medium">#</th>
                        <th className="text-left p-2 font-medium">指纹</th>
                        <th className="text-left p-2 font-medium">状态</th>
                        <th className="text-left p-2 font-medium">凭据 ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {finalResults.map((item) => (
                        <tr key={item.index} className="border-t">
                          <td className="p-2">{item.index + 1}</td>
                          <td className="p-2 font-mono text-xs">{item.fingerprint}</td>
                          <td className="p-2">
                            <div className="flex items-center gap-1">
                              {renderActionIcon(item.action)}
                              {renderActionText(item.action)}
                            </div>
                          </td>
                          <td className="p-2">
                            {item.credentialId ? `#${item.credentialId}` : item.reason || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {step === 'input' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                取消
              </Button>
              <Button onClick={handlePreview} disabled={!jsonText.trim() || isPending}>
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    解析中...
                  </>
                ) : (
                  '预览'
                )}
              </Button>
            </>
          )}

          {step === 'preview' && (
            <>
              <Button variant="outline" onClick={() => setStep('input')}>
                返回
              </Button>
              <Button
                onClick={handleConfirmImport}
                disabled={isPending || (previewSummary?.added ?? 0) === 0}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    导入中...
                  </>
                ) : (
                  `确认导入 (${previewSummary?.added ?? 0})`
                )}
              </Button>
            </>
          )}

          {step === 'result' && (
            <Button onClick={handleClose}>完成</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
