# Changelog

## 0.10.0

- Remove the official QQ reuse and local relay hijack mode: never read `worlds.qq` or call `setConnection` on other extensions; connect directly to OneBot v11 (e.g., NapCat) instead.
- Replace cross-provider LLM resolution with self-contained OpenAI-compatible LLM settings inside this World (Base URL, model name, API Key stored via `ctx.secret()`, and optional reminder tone).
- Remove reading `workspace/CONSTITUTION.md`; reminder wording now uses this World's own built-in or user-configured tone prompt.
- Require explicit user confirmation in the WebUI (listing source directory, target directory, and files to copy) before copying Coopanion's Electron runtime files for the desktop countdown widget.

## 0.9.1

- Expand the npm package README with feature overview, quick-start steps, and live preview screenshots.
- Add the desktop countdown widget screenshot and refresh editor preview screenshots in docs.

## 0.9.0

- Add QQ group reminders alongside private reminders, with separate delivery receipts and retries per destination.
- Leave private recipient, group and master QQ blank by default; never select recipients from the host or official QQ configuration, including on upgrade.
- Add an opt-in group command switch and independent permissions for the configured master, group administrators and group owner. All switches default off.
- Only process explicit add commands from authorized members in the configured group; replies contain the new event only and stay in that group.
- Keep editing and the countdown available without QQ, and preserve ordinary QQ traffic when no reminder destination is configured.

## 0.8.0

- Prepare the standalone personal agenda plugin for publication, including QQ reminders and the desktop countdown.
- Restrict the build, installer, page bundle and release archive to the approved agenda package.

## 0.6.0

- Add a first-run QQ setup dialog with recipient selection, official QQ reuse, manual connection, secret storage and advanced ports.
- Keep calendar editing and countdown available when QQ is unconfigured or offline, including a fresh empty installation.
- Test login without sending messages; explain authentication errors, refused connections, timeouts and occupied relay ports.
- Reconfigure the QQ relay without restarting the countdown, and preserve the original official QQ credentials and ordinary chat route.
- Invalidate in-flight reminder or natural-language work after the recipient or connection changes.

## 0.5.0

- Move the time zone selector into each event editor and store it independently per event.
- Display and describe mixed-zone events using their own zones across the list, QQ and countdown.
- Preserve unchanged event instants when switching an editor's zone; retain legacy time zones without resetting data.
- Let QQ commands specify a zone after the time, and make natural edits inherit the target event's zone.

## 0.4.0

- Add a shared time zone setting, following the computer by default, across editing, QQ interpretation/commands, reminder wording and the desktop countdown.
- Resolve local input on the backend with offsets at the event date; reject nonexistent local times and require a choice for repeated DST hours.
- Preserve existing event instants and delivery receipts when changing zones; reject stale edits or generated wording after a zone change.
- Keep explicit time zones from existing agenda files, with no data reset.

## 0.3.2

- Use language-neutral Title and Subtitle labels and remove the language assumption from agenda interpretation prompts.
- Mark required and optional editor fields, and clarify default time status and how to disable all reminder offsets.

## 0.3.1

- Add a persistent QQ automatic reminder switch to the agenda page, independently of the desktop countdown and ordinary QQ chat.
- Stop pending reminder generation when the switch is off; leave manual agenda queries and delivery receipts intact.
- Verify the installed official QQ 0.2.15 driver connects and reconnects through the relay after a simulated upstream loss.

## 0.3.0

- Split presentation into `title`, `subtitle`, `remark` (top label), and `details` (long description).
- Remove hardcoded event-ID title/translation overrides.
- Read legacy pipe-separated titles and `notes` without automatically inventing translations.
- Preserve event IDs, reminder times and delivery deduplication when editing presentation fields.
- Include the short remark and long details in QQ reminders.

## 0.2.0

- Keep desktop controls on plugin pages; remove extra tray icons, host menu injection and automatic host source patches.
- Add agenda create/edit/cancel/restore, filters, search, notes, HTTPS links and reminder offsets.
- Reject stale edits and invalid dates; retain event IDs, delivery receipts and existing data.
- Invalidate an in-flight reminder when its displayed content changes.
- Prepare source-only GitHub distribution, tests, screenshots, local installer and license notices.
