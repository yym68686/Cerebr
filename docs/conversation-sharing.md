# Conversation sharing

The conversation context menu provides **Copy share link**. The author signs in
to cloud sync first; recipients can open a link without an account. Links use
`#/share/<random-id>` so static hosts, project subpaths and either official
domain work without server-side route rewrites. Web links use the current host;
desktop and extension clients use `https://cerebr.fugue.pro/`.

Creating a share publishes a snapshot of that conversation, including message
text, images, reasoning, quotes, document attachments and cached webpage text.
PDF originals are retained. API keys, API configuration, private chat IDs and
browser tab IDs are excluded using a field allowlist on both client and server.
Webpage caches include only HTTP/HTTPS sources; local file URLs and their cached
page text are excluded. Documents attached to messages remain included.
No other conversations are uploaded. Anyone holding the link can read this
snapshot. Copying the same conversation's link again does not publish later
messages. **Update shared content** explicitly replaces the public snapshot;
**Stop sharing** removes it from the service.

Opening a link displays the fetched conversation directly in the chat area,
without an import dialog. Local persistence runs in the background, using the
recipient's model selection. The composer becomes available once saving finishes;
if saving fails, the readable preview remains with an inline retry action.
The chat and all its webpage sources are committed in one
IndexedDB transaction and enter normal local/cloud sync. Concurrent tabs and
repeat visits use the same imported copy. Reopening never overwrites subsequent
messages or removed sources, and an existing copy works offline or after the
author stops sharing. After deleting an imported copy, opening the link again
can import the currently published snapshot. Revocation cannot remove copies
already imported by recipients.

The sync service source is in `services/sync/`, with its own dependencies,
PostgreSQL schema, tests and Docker Compose deployment. It remains a separate
service; deploying the frontend does not automatically deploy its API. See its
README for deployment instructions. Changes to the snapshot schema must update
both `src/domain/chat/share-snapshot.js` and
`services/sync/server/share-snapshot.js`.

Validation:

```sh
npm run check
npm run package:extension
cd services/sync
npm ci
# DATABASE_URL must name a dedicated database ending in _test.
DATABASE_URL=postgres://.../cerebr_sync_test npm run check
```
