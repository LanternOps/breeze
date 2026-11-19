# Doc-derived script output

These files are what `wmiScript` (script.go) is expected to print, written from
HP's documentation of the `root/HP/InstrumentedServices/v1` classes and from
PowerShell 5.1's `ConvertTo-Json` behaviour (a one-element array can arrive as
a bare value). They are not captured device output. Every identifier in them is
invented.

`script_business.json` also carries values under denied property names
(`SerialNumber`, `ProductNumber`) as a misbehaving script would print them: the
Go side must drop them whatever the script sends.

When observe runs on real devices, rebuild these from the observed schema with
every value replaced (amendment §3, `t0_ingest` evidence). Never commit captured
values.
