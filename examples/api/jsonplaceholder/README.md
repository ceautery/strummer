# jsonplaceholder — sample Sackville API collection

A runnable Bruno collection that exercises [JSONPlaceholder](https://jsonplaceholder.typicode.com),
a free, no-auth REST test API. Used by the [CLI quickstart](../../../packages/cli/README.md#api-testing-quickstart).

## Requests

| request       | method | what it does                                         |
| ------------- | ------ | ---------------------------------------------------- |
| `get-user`    | GET    | fetch user 1; assert 200 + JSON + `$.name`; capture `userName` |
| `list-posts`  | GET    | list posts for user 1; assert 200 + `$[0].userId == 1` |
| `create-post` | POST   | create a post; **dry-runs by default** (mutating)    |

`{{baseUrl}}` is supplied by `environments/Public.bru`, so pass `--env Public`.

```bash
S="node packages/cli/dist/bin.mjs"          # from the repo root, after `pnpm -r build`

$S api list           examples/api/jsonplaceholder
$S api run            examples/api/jsonplaceholder get-user   --env Public
$S api run-collection examples/api/jsonplaceholder get-user list-posts --env Public

# Mutating request: dry-runs unless explicitly unlocked + host-allowlisted.
$S api run examples/api/jsonplaceholder create-post --env Public
$S api run examples/api/jsonplaceholder create-post --env Public \
    --unsafe --allow-host jsonplaceholder.typicode.com
```

The `.bru` files are plain Bruno requests (open the folder in the Bruno GUI if
you like); the `*.sackville.yml` sidecars hold Sackville's assertions/captures.
