# Preview fixtures (Wails / WebKit matrix)

Inputs for the manual preview matrix and for `preview_server_fixtures_test.go`.

## Committed

| Path | Exercises |
|---|---|
| `html-rel-assets/` | HTML + relative CSS, SVG image, ES module script and `fetch('./data.json')` — the exact combination that rendered blank under `file://` in WebKit. |
| `html-form-demo.html` | Form submit, `<dialog>` modal, download and popup links — validates the iframe sandbox tokens. |

## Generated (not committed)

Large fixtures are deterministic and git-ignored; generate them with:

```bash
node apps/desktop/scripts/gen-preview-fixtures.mjs
```

| Path | Size | Exercises |
|---|---|---|
| `large/md-large.md` | ~2 MB | Sectioned markdown rendering, lazy mount bound |
| `large/py-large.py` | 30k lines | Plain-mode threshold (no Shiki) + opt-in highlight |
| `large/img-huge.png` | 2600×2600 | Thumbnail generation (≤1024 px), no base64 through the bridge |
| `large/gif-anim.gif` | 2 frames | Animated GIF passthrough |
| `large/text-huge.log` | ~4 MB | 512 KB read cap + truncation banner |

## Manual matrix (Wails on Linux + Electron for comparison)

Run `alice desktop` from a checkout, then open each fixture via the file browser
and (for HTML) the preview action.

| Case | Expected |
|---|---|
| `html-rel-assets/index.html` | Title, pink heading, logo, `{"fixture": ...}` in `#result`, `body[data-fixture-result="ok"]`; no CORS errors |
| `html-form-demo.html` | Submit shows `hello Alice`; dialog opens; download works; popup opens externally |
| HTML with `fetch('https://example.com')` | Request blocked by CSP (`connect-src 'self'`), page stays usable |
| `large/img-huge.png` | Image renders; served thumbnail ≤1024 px (DevTools/network) |
| `large/gif-anim.gif` | Both frames animate |
| `large/md-large.md` | Opens immediately; scrolling mounts sections; DOM node count stays bounded |
| `large/py-large.py` | Plain text by default with the "Highlight anyway" banner |
| `large/text-huge.log` | Large-file refusal → "Preview anyway" → truncation banner |
| Close an HTML preview tab | Loopback listener stops (port no longer answers) |
| Open 20 file tabs | Tab list caps at 12, newest kept |

## Automated coverage

- `apps/desktop-wails/preview_server_test.go` — origin, traversal, tokens, headers, thumbnails, stop/port release.
- `apps/desktop-wails/preview_server_fixtures_test.go` — serves the committed fixtures end to end (HTML, CSS, module, JSON, SVG, form demo).
- `apps/desktop-wails/preview_e2e_test.go` — `TestPreviewE2E`, the harness the script below drives (15 named cases).
- `apps/desktop/scripts/e2e-preview-wails.mjs` — generates the large fixtures, runs the Go harness, prints one row per case plus the manual list. Run with `npm run --prefix apps/desktop test:preview:e2e`.
- `apps/desktop/src/app/chat/right-rail/preview-pane.wails.test.tsx` — loopback URL wiring, sandbox attributes, teardown.
- `apps/desktop/src/app/chat/right-rail/preview-pane.fallback.test.tsx` — load failure → overlay, retry re-navigation, open-external, "View source" with no second origin, load timeout.
- `apps/desktop/src/app/chat/right-rail/preview-file.resources.test.tsx` — lazy diff, read cache, truncation, image limits.

## Last run

`node apps/desktop/scripts/e2e-preview-wails.mjs` — automated: **15 passed, 0 failed, 0 skipped**.

| Case | Result |
|---|---|
| serve_index_html | ✅ |
| serve_relative_css | ✅ |
| serve_es_module_mime | ✅ |
| serve_json_for_fetch | ✅ |
| serve_svg_image | ✅ |
| missing_asset_is_404 | ✅ |
| dotfile_is_403 | ✅ |
| symlink_escape_is_403 | ✅ |
| invalid_token_is_404 | ✅ |
| loopback_only_bind | ✅ |
| csp_and_nosniff_headers | ✅ |
| form_fixture_served | ✅ |
| thumbnail_dimensions | ✅ |
| gif_passthrough | ✅ |
| port_released_on_stop | ✅ |

The GUI rows above (paint, module execution, sandbox interactions, CSP block, animation, responsiveness, plain-mode banner, truncation banner) are **manual**: they need `alice desktop` on a machine with a display (WebKitGTK). The automation covers the origin contract those rows depend on; the visual/interaction assertions remain pending a GUI run.

