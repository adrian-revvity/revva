import type { Components } from 'react-markdown'

/**
 * Markdown rendering for assistant messages. react-markdown passes an extra
 * `node` prop, so every renderer destructures it out before spreading onto DOM.
 */
export const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      className="cursor-pointer text-blue-600 underline underline-offset-2 dark:text-blue-400"
      onClick={(e) => {
        e.preventDefault()
        if (props.href) void window.revva.shell.openExternal(props.href)
      }}
    />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="overflow-x-auto rounded-md border border-black/10 bg-black/[0.04] px-3 py-2 text-xs leading-relaxed dark:border-white/10 dark:bg-white/[0.06] [&_code]:bg-transparent [&_code]:p-0"
    />
  ),
  code: ({ node: _node, ...props }) => (
    <code {...props} className="rounded bg-black/10 px-1 py-0.5 font-mono text-[11px] dark:bg-white/10" />
  ),
  table: ({ node: _node, ...props }) => <table className="my-2 w-full border-collapse text-xs" {...props} />,
  th: ({ node: _node, ...props }) => (
    <th className="border border-black/15 px-2 py-1 text-left font-medium dark:border-white/15" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border border-black/15 px-2 py-1 align-top dark:border-white/15" {...props} />
  ),
  // Tight spacing: bubbles are compact, so markdown's default margins are too wide.
  p: ({ node: _node, ...props }) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4" {...props} />,
  li: ({ node: _node, ...props }) => <li className="pl-0.5" {...props} />,
  h1: ({ node: _node, ...props }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-1.5 border-l-2 border-black/20 pl-3 italic opacity-80 dark:border-white/25" {...props} />
  ),
  hr: () => <hr className="my-3 border-black/10 dark:border-white/15" />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold" {...props} />,
  // GFM task lists render a disabled checkbox.
  input: ({ node: _node, ...props }) => (
    <input type="checkbox" disabled className="mr-1.5 size-3 translate-y-0.5 accent-primary" {...props} />
  )
}

