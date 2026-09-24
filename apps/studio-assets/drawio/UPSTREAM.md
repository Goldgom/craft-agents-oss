# Bundled draw.io runtime

This directory contains the draw.io web runtime from
`https://github.com/jgraph/drawio`, version **31.4.6**, commit
`744cb5420fdf126efd7a09b1d7082ca3e12c0841`.

The source is licensed under Apache License 2.0; see [LICENSE](LICENSE).
Only the static editor runtime and its local assets are bundled. The server
components (`WEB-INF`, `META-INF`) and third-party cloud integrations are
excluded. TokenBird loads the runtime in an iframe using draw.io's JSON embed
protocol with `offline=1`. The packaged desktop app serves these files through
the restricted `tokenbird-studio://drawio/` protocol so draw.io can read its
own language files without `file://` CORS failures.
