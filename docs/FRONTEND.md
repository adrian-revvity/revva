# revva — Frontend component policy

## UI library

Use **shadcn/ui** in the React renderer, configured for the Vite-based Electron app with the shadcn CLI. Components are added to the codebase and owned by Revva rather than imported as a closed UI package. Keep the generated `components.json`, aliases, Tailwind integration, and theme tokens as the source of truth.

Initialize during M0 using the current [shadcn Vite installation guide](https://ui.shadcn.com/docs/installation/vite). Choose a supported component base during init and keep that choice consistent; use shadcn's `base-vs-radix` guidance before changing it later.

## Reuse-first rule

Before writing a component:

1. Inspect `components.json` and the installed `src/components/ui` inventory.
2. Check shadcn docs/CLI (`shadcn search`, `shadcn view`, `shadcn docs`) and, when useful, the configured shadcn MCP registry for a component or composition.
3. Prefer using/composing the existing component; extend via supported variants, slots, and class names rather than forking its primitive behavior.
4. Build a new component only for Revva-specific domain composition or an interaction with no suitable existing component. Compose it from shadcn primitives and record why an existing component was insufficient.

Do not create one-off Button, Input, Select, Checkbox, Switch, Dialog, Dropdown, Tooltip, Tabs, Badge, Card, Table, Toast, or other generic primitives already available from shadcn/ui.

## Likely component mapping (verify the current registry/API before install)

| Revva surface | Prefer existing shadcn components |
| --- | --- |
| App shell / navigation | `Sidebar`, `Resizable`, `Tooltip`, `Dropdown Menu`, `Command`, `Separator` |
| Jira board / ticket lists | `Table` or `Data Table`, `Card`, `Badge`, `Item`, `Skeleton`, `Empty` |
| Start Work / settings | `Dialog`, `Field`, `Input`, `Textarea`, `Combobox`, `Select`, `Checkbox`, `Switch`, `Button` |
| Question inbox / blockers | `Tabs`, `Sheet`, `Alert`, `Alert Dialog`, `Badge`, `Progress` |
| General chat / agent transcript | shadcn AI Elements such as `Chat`, `Message`, `Message Scroller`, `Prompt Input`, `Tool`, `Subagent`, `Task`, where they fit the current React API |
| Notifications / phase status | `Sonner`/Toast, `Spinner`, `Progress`, `Badge`, `Alert` |

These are starting points, not a requirement to install every component. Use the official CLI to add only components needed by a feature (e.g. `pnpm dlx shadcn@latest add sidebar dialog button`).

## Developer tools installed for this project

- **shadcn skill:** installed project-locally at `.agents/skills/shadcn` from `shadcn/ui`, tracked with `skills-lock.json`. It supplies project-aware component discovery, composition, styling, and CLI instructions to OpenCode.
- **shadcn MCP:** configured in the project-level `opencode.json` as a local server running `npx -y shadcn@latest mcp`. The server can browse/search/install from the default shadcn registry and registries declared in `components.json`. It is a development assistant integration, not a runtime dependency of the shipped app.
- **Docs source:** [`https://ui.shadcn.com/llms.txt`](https://ui.shadcn.com/llms.txt), [Vite installation](https://ui.shadcn.com/docs/installation/vite), [MCP server](https://ui.shadcn.com/docs/mcp), [skills](https://ui.shadcn.com/docs/skills).

When asking an implementation agent to build UI, instruct it to use the project-local shadcn skill and MCP, inspect current components first, and add components through the shadcn CLI rather than hand-rolling primitives.
