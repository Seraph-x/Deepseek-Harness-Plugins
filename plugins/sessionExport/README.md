# dsh-session-export

Export a DeepSeek Harness session log as a transcript in one of five formats —
Markdown, plain text, HTML, JSONL, or PDF — with optional redaction of home
paths, user names, e-mail addresses, and credentials.

Two entry points, one implementation:

- **tool** `export_session` — callable by the model in any session.
- **command** `/export-session [path] [flags]` — one keystroke for the human.

## Formats

| `format` | Extension | What it is |
| --- | --- | --- |
| `markdown` | `.md` | metadata table, clickable TOC, one section per turn, adaptive fences |
| `text` | `.txt` | the same transcript with all markup stripped, fixed-width headings |
| `html` | `.html` | one self-contained file, inline CSS, light and dark, no scripts, no external assets |
| `jsonl` | `.jsonl` | one JSON record per block, for downstream tooling |
| `pdf` | `.pdf` | the **plain-text** transcript typeset on A4, page numbers in the footer |

PDF carries exactly the same content as `text` — no images, no links, no
colour. It is written by a zero-dependency PDF writer in `lib/render-pdf.js`:
Courier for ASCII and `STSong-Light` (Adobe-GB1) for CJK, neither embedded, so
the file stays small and every reader falls back to its own fonts.

## What a transcript contains

1. a metadata header (session id, creation time, working directory, log record
   count, turn count, tool-call count, export time),
2. a table of contents (one entry per human turn) — Markdown and HTML only,
3. one section per human turn: the user message, then the assistant text, tool
   calls (fenced JSON arguments), and tool results (head and tail lines with an
   explicit `[... N lines omitted ...]` marker),
4. turn notices — aborts, cancellations, errors, compactions, permission
   denials — so a transcript never silently loses a failed turn,
5. reasoning blocks only when `include_reasoning` is on.

Fences are adaptive: if a payload itself contains triple backticks, the fence
grows so nested code blocks survive. A transcript whose fences do not balance
is reported with `WARNING: unbalanced code fences` instead of failing.

## Redaction

Redaction runs over the finished document, not per block, so headings and the
table of contents are covered too.

| Category | Becomes |
| --- | --- |
| `/Users/<name>`, `/home/<name>` | `~` or `<home>` (`pathStyle`) |
| `C:\Users\<name>` and the leftover backslashes | same replacement, `/` separators |
| bare user name | `<user>` |
| e-mail address | `<email>` |
| `ghp_…`, `github_pat_…`, `AKIA…`, `xox?-…`, `sk-…`, `AIza…` | `<token>` |
| `npm_…`, `pypi-…`, `dckr_pat_…`, JWTs, `Bearer …` | `<token>` |
| `scheme://user:password@host` | `scheme://user:<redacted>@host` |
| `Authorization: Basic …` | `Authorization: Basic <redacted>` |
| `aws_secret_access_key = …` | `aws_secret_access_key = <redacted>` |
| any assignment whose **key** looks secret (`password`, `token`, `secret`, `api_key`, `DB_PASSWORD`, `db_pass`, …) | value becomes `<redacted>`, whatever its length or shape |
| `-pSecret123`, `--password xxx`, `--token=xxx` | value becomes `<redacted>` |
| `cf_clearance=`, `PHPSESSID=`, `sessionid=`, CSRF tokens, `Cookie:` headers | value becomes `<redacted>` |
| private key blocks | `<private-key>` |
| `config.literals` entries | `<redacted>` |

The key decides, not the value: `password = hunter2` is redacted even though it
is short and alphabetic. Placeholders are left alone — `password = process.env.X`,
`token: ${TOKEN}`, `api_key = null`, `password = <your-password>`.

The tool result reports per-category hit counts, so a redaction sweep is
verifiable instead of assumed.

## Tool parameters

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `session_id` | string | current session | one session to export |
| `sessions` | string[] | — | batch export; per-session failures come back in `failed` |
| `format` | enum | `markdown` | `markdown` \| `text` \| `html` \| `jsonl` \| `pdf` |
| `output_path` | string | — | exact file path (extension added when missing) |
| `output_dir` | string | session cwd | directory; the file name comes from `fileName` |
| `overwrite` | boolean | `false` | reuse the name instead of appending `-1`, `-2`, … |
| `sanitize` | boolean | `true` | run the redaction pass |
| `include_tool_results` | boolean | `true` | include tool results |
| `include_tool_calls` | boolean | `true` | include tool calls |
| `include_reasoning` | boolean | `false` | include reasoning blocks |
| `include_notices` | boolean | `true` | include abort / error / compaction notices |
| `result_head_lines` | integer | `60` | head lines kept per tool result |
| `result_tail_lines` | integer | `15` | tail lines kept per tool result |

The result is `{ exports: [...], failed: [...] }`. Each export item carries
`session_id`, `path`, `format`, `bytes`, `records`, `turns`, `tool_calls`,
`tool_results`, `fences_balanced`, `redactions[]`, and `pages` for PDF.

## Command flags

    /export-session                          markdown next to the session cwd
    /export-session --pdf                    PDF, same place
    /export-session out/session.txt          exact path
    /export-session --out=out/s.pdf --pdf
    /export-session --all --dir=dumps --html every session in the cache
    /export-session --pdf --no-tools --reasoning
    /export-session --no-sanitize --overwrite

`--pdf --txt --md --html --jsonl --format=<name> --out= --dir= --all
--no-tools --no-calls --reasoning --no-notices --no-sanitize --overwrite -f`

## Configuration

Plugin config (a row in the profile's `cordis.patch.yml`):

    - id: session-export
      name: "dsh-session-export"
      config:
        format: markdown
        sanitize: true
        pathStyle: tilde
        includeReasoning: false
        includeToolCalls: true
        includeToolResults: true
        includeNotices: true
        resultHeadLines: 60
        resultTailLines: 15
        maxArgumentChars: 4000
        ruleWidth: 78
        fileName: "session-{short}.{ext}"
        overwrite: false
        usernames: []
        literals: []

`fileName` placeholders: `{id}`, `{short}`, `{date}`, `{time}`, `{format}`,
`{ext}`. Every tool parameter above overrides the config value per call.

## Install

1. Add the package to the profile:

       cd ~/.dsh/profiles/desktop
       pnpm add link:/path/to/Deepseek-Harness-Plugins/plugins/session-export

   or add the `link:` dependency by hand and run `pnpm install`.

2. Append the bundle name to `dsh.profile.bundles` in the profile's
   `package.json`.

3. Restart the host (host plugins load at boot; skill-style hot reload does
   not apply to bundles).

## Tests

    cd plugins/session-export
    node --test test/

Covers the redaction rules (including the linear-time e-mail scan), label
sanitising, every renderer, the PDF object layout and xref offsets, the
command-line parser, and the file-name template.

## Notes

- Host-side only: no client bundle, no routes, no UI.
- Reads through the `sessionPersistence` read handle after flushing the live
  session, so the transcript always includes the current turn.
- No `@deepseek-ai/*` imports and no third-party dependencies: only Node
  builtins, so the package resolves from a `link:` install and the PDF writer
  needs nothing installed.
- Exporting a 2 MB, 754-record session takes about 40–65 ms per format; the
  e-mail scan is bounded so a long identifier run cannot stall the pass.
