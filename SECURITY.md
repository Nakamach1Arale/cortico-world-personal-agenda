# Security and privacy

Do not include real `.env` files, access tokens, QQ account configuration, agenda files, chat archives or health data in issues, screenshots or pull requests. Use the synthetic fixtures supplied by the tests.

Reminders go only to the explicitly entered private QQ and/or group. Both destinations and the master QQ default to blank, including when upgrading from the legacy owner setting. The master identity does not opt anyone into reminders. Private and group destinations share one calendar; configuring a group deliberately shares its reminder content with that group.

Group commands default off. Only explicit add commands from independently selected master, administrator or group-owner identities in the configured group are handled. The reply contains only the added event. This module does not provide group listing, editing or cancellation. Role checks use the authenticated OneBot event's sender metadata; the OneBot server must be trusted.

The relay binds only to loopback and requires the matching OneBot token. The web editor is part of the host's authenticated administration surface; it is not exposed as an agent mutation tool. Deployments remain responsible for access to the host console and NapCat.

Report security-sensitive details privately to the repository maintainer rather than posting credentials in a public issue.
