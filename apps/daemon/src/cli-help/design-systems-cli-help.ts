// Help surface for `od design-systems`. Kept pure and separate from cli.ts so a
// test can assert the advertised subcommands without spawning the CLI or
// stubbing process.exit / console.log.

export const DESIGN_SYSTEMS_USAGE = `Usage:
  od design-systems list                       List design systems.
  od design-systems show <id>                  Print one entry.
  od design-systems create --title <title> --prompt-file <path|->  Save a DESIGN.md document.
  od design-systems update <id> --prompt-file <path|->  Update an editable document.
  od design-systems delete <id>                Delete an editable document.
  od design-systems rename <id> --title <new>  Rename an editable design system.
  od design-systems download <id> [--out <p>]  Download a brand .zip (files + SKILLS.md).
  od design-systems import-local <path>        Import a local project.
  od design-systems import-github <url>        Import a public GitHub repo.
  od design-systems import-shadcn <reference>  Import a shadcn registry item.
  od design-systems rebuild-token-contract <id>  Start a token contract rebuild review.
  od design-system members <id>                Your role and everyone who may use a private document.
  od design-system share <id> <username>       Owner: let another account of this server use it.
  od design-system unshare <id> <username>     Owner: revoke; admitted runs keep their captured version.
  od design-system leave <id>                  Grantee: remove a document shared with you.

Document options: --title, --summary, --category, --surface, --status, --json.

Workspace options:
  --workspace <id>         Exact Workspace for a bound design system.
  --workspace-member <id>  Exact caller membership for a bound design system.
                           Pass both together, or omit both for legacy local data.`;

// `help`, `--help`, and `-h` all route to the usage text above. Without the
// flag forms, `od design-systems --help` falls through to the generic library
// list, which only advertises `list` and `show` and never mentions `rename`.
export function isDesignSystemsHelpArg(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h';
}
