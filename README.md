# pi-resource-manager

A standalone, theme-compatible Pi extension for managing Pi packages/extensions and Pi skills.

## What it manages

- Pi packages installed through `pi install`
- Global Pi extensions in `~/.pi/agent/extensions/`
- Pi skills in `~/.pi/agent/skills/` and `~/.agents/skills/`

## Commands

- `/resources` - open the Resource Manager
- `/skills` - open directly on the Skills tab
- `/resource-extensions` - open directly on the Extensions tab

## UI keys

- `Tab` - switch tabs
- `Up` / `Down` - navigate
- `Enter` - inspect
- `x` - enable/disable by quarantine/restore
- `u` - update
- `d` - quarantine/remove
- `r` - reload Pi resources
- `Esc` - close

## Safety model

- Destructive local extension/skill actions quarantine by default.
- Permanent delete is intentionally not implemented in v1.
- The Resource Manager refuses to quarantine itself in v1.
- Unknown/local skills are not updateable.
- Skill updates are trusted-only:
  - `.agents/.skill-lock.json` metadata clones a trusted source and copies the skill folder.
  - Git-managed skill repositories update with `git pull --ff-only`.
  - The extension never infers update sources from skill names.
- Package updates use `pi update <source>`.
- Package removal uses `pi remove <source>`.

## Install for development

From this repo:

```bash
pi -e ./src/index.ts
```

For a one-shot startup check:

```bash
pi -e ./src/index.ts --list-models
```

To install as a package from a local checkout:

```bash
pi install ./path/to/pi-resource-manager
```

The package manifest exposes the extension through:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Development

Run the core tests:

```bash
npm test
```

Run the syntax check:

```bash
npm run check
```

## Notes

`npm:@juicesharp/rpiv-ask-user-question` is a separate Pi package. It appears as a package row rather than a local extension row when installed through Pi package management.
