# Repository Instructions

## Git

The commit helper cannot include untracked files directly. If given an untracked file,
it rejects the file and creates no commit. Stage new files first with `git add`, then
invoke the commit helper.

## Agent Keys Runtime

Agent Keys runs in the local VS Code extension host. Build/package with `npm run package`,
then install the VSIX or use the Extension Development Host (F5).
Use Agent Keys: Restart Connection to reconnect, or Agent Keys: Reset Keys to clear bindings.
PNever use process.exit, process-wide signal handlers, or detached daemons in runtime code.
Keep Input.app running; only the elected extension owner may connect to Input.
Do not start the legacy LaunchAgent alongside the extension.

## Tests

`npm test` is not supported inside the sandbox because it cannot handle the test
suite's `127.0.0.1` listeners and connections. Run it with unsandboxed execution.

## Shell Commands

JavaScript containing `!==` can trigger shell history expansion when embedded in a
command string. Run multiline JavaScript with a quoted heredoc such as
`node --input-type=module <<'NODE'` so the shell treats `!` literally.