# Android upload signing

`breeze-upload.jks` is the **upload key** for Google Play App Signing. It is
gitignored (`*.jks`) and MUST be backed up outside this machine (1Password),
together with the password in `~/.gradle/gradle.properties`. Losing it means a
key-reset request through Play Console support before the next release.

Gradle reads it through `src/config/androidUploadSigning.js`, which only
activates when `BREEZE_UPLOAD_STORE_FILE` is defined as a Gradle property.
