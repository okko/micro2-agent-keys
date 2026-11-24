# Device and configuration safety

Input.app is the sole owner of keyboard communication. Keep it running.
AgentKeys only uses the supported local WebSocket API to receive API Smart Action
events and update their lighting.

- AgentKeys never changes or removes existing layouts, profiles, layers or firmware.
- Create API Smart Actions manually in Input, or run **AgentKeys: Add Layer**. That
  command runs only when invoked, asks for confirmation naming the device, profile and
  key count each time, and uses Input's `addLayer`, which appends a new layer and
  leaves existing ones untouched. It re-checks the device and profile before sending
  and never retries a failed or uncertain write.
- API authorization is required and credentials are stored in VS Code SecretStorage.
- InputKit serializes requests and paces device writes. Shared device rate limits
  receive bounded retries with increasing delays.
- The extension elects one owning window so instances do not compete over the same lights.
  Stop the old daemon before configuring the extension.
- Unmapped keys are logged and skipped; transport and unexpected API errors are
  reported and cause reconnection.

Use Input's supported configuration and recovery workflows for device changes.
