# Browser store publishing

After a successful GitHub Release, `release.yml` calls `publish-stores.yml` to submit Chrome, Edge, and Firefox independently. A store failure does not cancel the other stores or remove the GitHub Release. Approval remains the responsibility of each store.

The workflow downloads the exact release ZIP instead of rebuilding it. It checks out the release tag to verify its version and to package Firefox's reviewer sources, including the pinned `htmd` submodule, lockfile, and `REVIEW-BUILD.txt`. No credentials are included in these sources.

Repository settings → Secrets and variables → Actions:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `CHROME_PUBLISHER_ID` | Publisher ID from Chrome developer settings |
| Variable | `CHROME_EXTENSION_ID` | Store item ID |
| Secret | `CHROME_SERVICE_ACCOUNT_JSON` | Complete JSON key for the service account linked in Chrome publisher settings |
| Variable | `EDGE_PRODUCT_ID` | Partner Center product GUID, not the public extension ID |
| Secret | `EDGE_CLIENT_ID` | Publish API client ID |
| Secret | `EDGE_API_KEY` | Publish API v1.1 key |
| Variable | `EDGE_API_KEY_EXPIRES_AT` | Key expiry timestamp for maintenance reference |
| Variable | `FIREFOX_ADDON_ID` | Existing add-on GUID matching the manifest |
| Secret | `FIREFOX_API_KEY` | AMO JWT issuer |
| Secret | `FIREFOX_API_SECRET` | AMO JWT secret |

Enable Chrome Web Store API in the service account's Cloud project. The service account needs no broad project IAM role. Its Chrome publishing permission comes from the publisher dashboard binding. Firefox credentials are available after email confirmation on AMO's API key page. Edge keys expire: replace the GitHub secret and expiry variable before the date shown in Partner Center.

To retry, rerun failed jobs or manually run **Publish browser stores** on `main`, choosing the latest public release and optionally one store. Chrome checks whether the version is already published or in review; it never cancels another review. Firefox checks the existing listed version and repairs a missing source attachment. Edge saves upload and submission operation IDs as Actions artifacts and restores them on retry; these checkpoints contain no credentials. If a mutating request loses its response before an operation ID is received, inspect the dashboard before retrying. Expired checkpoint artifacts also require a dashboard check for Edge.

Only public stable releases are submitted. Store workflows are serialized; if a store still has another version in review, the job reports the conflict and can be retried after review. These jobs submit for review and do not wait indefinitely for human approval.

Official API references: [Chrome v2](https://developer.chrome.com/docs/webstore/using-api), [Chrome service accounts](https://developer.chrome.com/docs/webstore/service-accounts), [Edge v1.1](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api), [Firefox submission API](https://mozilla.github.io/addons-server/topics/api/addons.html).
