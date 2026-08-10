# Repository Instructions

## Git

The commit helper cannot include untracked files directly. If given an untracked file,
it rejects the file and creates no commit. Stage new files first with `git add`, then
invoke the commit helper.

## AgentKeys Runtime

`scripts/restart-agent.sh` will not work in the sandbox. Run it with unsandboxed
execution so `launchctl` can restart the LaunchAgent in the user's GUI domain.

## Shell Commands

JavaScript containing `!==` can trigger shell history expansion when embedded in a
command string. Run multiline JavaScript with a quoted heredoc such as
`node --input-type=module <<'NODE'` so the shell treats `!` literally.