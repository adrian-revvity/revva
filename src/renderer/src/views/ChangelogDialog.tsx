import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

/** Setup-header entry point: bundled CHANGELOG.md in a dialog, with the version. */
export function ChangelogDialogButton(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const meta = useQuery({ queryKey: ['app-meta'], queryFn: () => window.revva.app.meta(), staleTime: Infinity })
  return (
    <>
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setOpen(true)}>
        <History className="mr-1 size-3.5" />
        v{meta.data?.version ?? '…'}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Changelog</DialogTitle>
            <DialogDescription>
              You are on v{meta.data?.version}. Releases with installers live on GitHub.
            </DialogDescription>
          </DialogHeader>
          <div className="text-[13px] leading-relaxed [&_a]:text-blue-600 [&_a]:underline dark:[&_a]:text-blue-400">
            {meta.data?.changelog ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // The file starts with its own H1 — skip it; versions are compact headings.
                  h1: () => null,
                  h2: ({ node: _n, ...props }) => <h3 className="mt-4 mb-1 text-sm font-semibold first:mt-0" {...props} />,
                  h3: ({ node: _n, ...props }) => <h4 className="mt-3 mb-1 text-[13px] font-semibold" {...props} />,
                  p: ({ node: _n, ...props }) => <p className="my-1.5" {...props} />,
                  ul: ({ node: _n, ...props }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4" {...props} />,
                  a: ({ node: _n, ...props }) => (
                    <a
                      {...props}
                      onClick={(e) => {
                        e.preventDefault()
                        if (props.href) void window.revva.shell.openExternal(props.href)
                      }}
                    />
                  )
                }}
              >
                {meta.data.changelog}
              </ReactMarkdown>
            ) : (
              <p className="text-xs text-muted-foreground">No bundled changelog found.</p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => void window.revva.shell.openExternal('https://github.com/adrian-revvity/revva/releases')}
          >
            Browse downloads on GitHub
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
