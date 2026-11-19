# Device and configuration safety

Input.app is the sole owner of keyboard communication. Keep it running.
AgentKeys only uses the supported local WebSocket API to receive API Smart Action
events and update their lighting.

- No configuration files, firmware, profiles or layers are written by AgentKeys.
- Create API Smart Actions manually in Input; existing layouts are not overwritten.
- API authorization is required and credentials are stored in macOS Keychain.
- InputKit serializes requests and paces device writes. Shared device rate limits
  receive bounded retries with increasing delays.
- Run one AgentKeys daemon so separate instances do not compete over the same lights.
- Unmapped keys are logged and skipped; transport and unexpected API errors are
  reported and cause reconnection.

The previous low-level research and configuration-writing tools have been removed.
Use Input's supported configuration and recovery workflows for device changes.
