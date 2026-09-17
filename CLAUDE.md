# typeful-triage

Multiplayer GitHub triage dashboard: Vite+ (`vp`), React, shadcn/ui, Rocicorp Zero, Hono, and
TypeSafe System One as the classifier. `README.md` covers setup; `docs/ARCHITECTURE.md` covers
the data model, flows and question design. Read both before changing behaviour.

## Working rules

- The TypeSafe SDK and every secret live only in `apps/api`. Never import the SDK in `apps/web`.
- Use the `typesafe` skill and the live docs it points at for any question or policy work. Do not
  invent SDK details.
- Keep `decide()` and the question builders pure and covered by canned-answer tests. Policy
  thresholds live in `packages/triage/src/policy.ts`, never inside a question.
- Changing a question's meaning, or adding or removing a family, means bumping
  `QUESTIONS_VERSION`. Old classification rows are history and are never edited.
- One in-flight TypeSafe request per repository. Log usage on every request and write it to the
  `run` table.
- New state must stream through Zero rows so every tab agrees; never block the list on a request.
- Everything runs through Vite+: `vp install`, `vp run dev`, `vp check --fix`, `vp run -r test`,
  `vp run migrate`. Do not document or script around pnpm directly.
- Write files in the formatter's style (double quotes), then run `vp check --fix` and
  `vp run -r test`. Prefer whole-file rewrites over string patches against formatted code, or
  assert the match count when patching.
- The API dev process restarts on every save and the worker pokes every repository at startup.
  When changing questions and the worker's row writer together, pause classification first or
  write both in one step, or a half-updated worker will burn a batch.
- UI follows Linear as the baseline: 13px body, hairline borders, one accent, no cards on grey,
  sentence case, no vertical table rules. Round pills with a dot are this app's judgments; flat
  square tags are facts mirrored from GitHub. See `apps/web/src/components/Marks.tsx`.
- Do not commit or push unless asked.

## Toolchain notes

- Node and pnpm versions are pinned in `package.json` under `devEngines` and fetched by Vite+.
  Change them with `vp env pin <version>`, never by hand or with a version manager file.
- Tests import from `vite-plus/test`, not `vitest`. Test config lives in each package's
  `vite.config.ts` under `test`.
- Keep imports on `vite-plus/*`; the `vite-plus/prefer-vite-plus-imports` lint rule is on.
- Browser and server have separate tsconfigs joined by the solution-style root `tsconfig.json`;
  shared packages must not touch DOM or Node globals.
- `erasableSyntaxOnly` is on: no constructor parameter properties or enums.
