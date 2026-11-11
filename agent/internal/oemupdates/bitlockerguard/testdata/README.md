# `manage-bde` samples

**Doc-derived, not captured from hardware.** They follow the layout Microsoft
documents for `manage-bde -protectors -get`. The Surface lab wave (W12, leg S4)
replaces them with real captures. IDs are made up and no recovery password is
included.

The agent asks with `-Type TPM`, so a recovery password is never in the output
it reads. Whether that flag behaves as documented is also confirmed in leg S4.

`manage-bde-localized-de.txt` shows why anything but the English labels reads as
unknown and fails closed: the label text is the only thing the parser anchors on.
