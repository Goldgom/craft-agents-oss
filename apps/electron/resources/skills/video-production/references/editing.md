# FFmpeg editing actions

Call `video_tool` with `action:"edit"` and `args:{inputAssetIds:[...],operation:...}`. The host creates a new output asset; it preserves the input files. Use IDs returned by `import_asset` or generation, in intended processing order.

| operation | args in addition to inputAssetIds |
| --- | --- |
| trim | `startSeconds`, `durationSeconds` |
| concat | ordered `inputAssetIds`, optional `width`, `height` |
| resize | `width`, `height` |
| crop | `crop:{x,y,width,height}` |
| rotate | `rotation`: 90, 180 or 270 |
| speed | `speed`: positive speed multiplier |
| mute | removes audio |
| volume | `volume`: nonnegative audio multiplier |
| extract_audio | `format`: `mp3` or `wav` |
| extract_frame | `startSeconds`, `format`: `png` or `jpg` |
| subtitles | `subtitlesAssetId`: imported SRT or VTT |
| overlay | `watermarkAssetId`: imported image |
| music | `musicAssetId`: imported audio, optional `volume` |
| transcode | `format`: `mp4` |

For a trim starting at 2 seconds and lasting 5 seconds:

```json
{"action":"edit","args":{"inputAssetIds":["actual-asset-id"],"operation":"trim","startSeconds":2,"durationSeconds":5}}
```

This returns a job; poll it with `action:"job",args:{jobId:"actual-job-id"}`. Report the returned output asset and server path after it completes. Source clips of different dimensions or mixed audio presence are normalized by concat before assembly. Subtitle and watermark inputs are asset IDs, never raw FFmpeg filters or shell commands.
