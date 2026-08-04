Every successful `npm run build` writes a new ID to `dist/build-id`. The daemon reads
that file once at startup, so `GET /build` identifies the code loaded by the running
process rather than whatever is currently on disk. After restarting the LaunchAgent,
run `scripts/verify-build.sh`; it compares the live endpoint with `dist/build-id` and
exits unsuccessfully if they differ.
