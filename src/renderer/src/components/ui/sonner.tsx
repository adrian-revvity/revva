import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheck, Info, Loader2, OctagonX, TriangleAlert } from "lucide-react"

/**
 * App-wide toast outlet (sonner): PR actions report their result here —
 * merged / rebased / failed, so outcomes are seen even when the dropdown
 * or dialog that triggered them has already closed. Styled from the
 * design tokens so toasts match popovers.
 */
function Toaster({ ...props }: ToasterProps) {
  // The app toggles dark mode by a `.dark` class on an ancestor (see index.css).
  const dark = document.documentElement.classList.contains("dark")
  return (
    <Sonner
      theme={dark ? "dark" : "light"}
      position="bottom-right"
      expand={false}
      icons={{
        success: <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" />,
        error: <OctagonX className="size-4 text-destructive" />,
        loading: <Loader2 className="size-4 animate-spin" />
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)"
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
