//! Wall-clock timestamps and RFC 3339 parsing for the helper (#12126).
//!
//! Every timestamp the helper writes or reads goes through here, so the wire
//! formats stay in one place:
//!
//! - [`parse_rfc3339_millis`]: `expiresAt` (user messages), `deadlineAt`
//!   (caller verification) and `sentAt` (chat). Security-relevant: caller
//!   verification fails closed on `None`.
//! - [`now_rfc3339`]: `last_activity` in the helper status file.
//! - [`now_rfc3339_secs`]: `sentAt` of a reply the user types in chat.
//! - [`local_log_timestamp`]: the `helper.log` line prefix.

use time::{Date, Month, OffsetDateTime};

/// Julian day number of 1970-01-01.
const UNIX_EPOCH_JULIAN_DAY: i64 = 2_440_588;

/// Parse an RFC 3339 timestamp into unix milliseconds. `None` if it is not one.
///
/// Accepts exactly what chrono 0.4's `DateTime::parse_from_rfc3339` accepted
/// before #12126 (pinned by the tests below), not `time`'s own RFC 3339 parser:
///
/// - `T`, `t` or one space between date and time; `Z`/`z` or `±HH:MM`
///   (hours 00–23, minutes 00–59, `-00:00` allowed, U+2212 MINUS SIGN allowed);
/// - any number of fractional-second digits (sub-millisecond digits are
///   truncated, never rounded);
/// - second `60` (a leap second) at any minute, read as one second after `:59`;
/// - years 0000–9999; nothing before or after the timestamp.
pub fn parse_rfc3339_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let digit = |i: usize| b[i].is_ascii_digit().then(|| i64::from(b[i] - b'0'));
    let two = |i: usize| Some(digit(i)? * 10 + digit(i + 1)?);
    let year = digit(0)? * 1000 + digit(1)? * 100 + digit(2)? * 10 + digit(3)?;
    if b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    if b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (month, day) = (two(5)?, two(8)?);
    let (hour, minute, second) = (two(11)?, two(14)?, two(17)?);
    let date = Date::from_calendar_date(
        i32::try_from(year).ok()?,
        Month::try_from(u8::try_from(month).ok()?).ok()?,
        u8::try_from(day).ok()?,
    )
    .ok()?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    // Bytes 0..19 are ASCII digits and separators, so 19 is a char boundary.
    let mut rest = &s[19..];
    let mut frac_ms = 0;
    if let Some(r) = rest.strip_prefix('.') {
        let n = r.bytes().take_while(u8::is_ascii_digit).count();
        if n == 0 {
            return None;
        }
        frac_ms = r.as_bytes()[..n]
            .iter()
            .chain(b"000")
            .take(3)
            .fold(0, |ms, c| ms * 10 + i64::from(c - b'0'));
        rest = &r[n..];
    }
    let offset_secs = parse_offset(rest)?;

    let days = i64::from(date.to_julian_day()) - UNIX_EPOCH_JULIAN_DAY;
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_secs;
    Some(secs * 1_000 + frac_ms)
}

/// `Z`, `z` or `±HH:MM` (hours 00–23) making up the whole of `s`, as seconds
/// east of UTC.
fn parse_offset(s: &str) -> Option<i64> {
    if s == "Z" || s == "z" {
        return Some(0);
    }
    let (negative, hhmm) = match s.strip_prefix('+') {
        Some(r) => (false, r),
        None => (
            true,
            s.strip_prefix('-').or_else(|| s.strip_prefix('\u{2212}'))?,
        ),
    };
    let b = hhmm.as_bytes();
    if b.len() != 5 || b[2] != b':' || !b[..2].iter().chain(&b[3..]).all(u8::is_ascii_digit) {
        return None;
    }
    let hours = i64::from(b[0] - b'0') * 10 + i64::from(b[1] - b'0');
    let minutes = i64::from(b[3] - b'0') * 10 + i64::from(b[4] - b'0');
    if hours > 23 || minutes > 59 {
        return None;
    }
    let secs = hours * 3_600 + minutes * 60;
    Some(if negative { -secs } else { secs })
}

/// The current UTC time as `YYYY-MM-DDTHH:MM:SS[.fff|.ffffff|.fffffffff]+00:00`.
pub fn now_rfc3339() -> String {
    format_datetime(OffsetDateTime::now_utc())
}

/// The current UTC time as `YYYY-MM-DDTHH:MM:SSZ` (sub-seconds truncated).
pub fn now_rfc3339_secs() -> String {
    format_secs_z(OffsetDateTime::now_utc())
}

/// The current local time as `YYYY-MM-DD HH:MM:SS`, or UTC if the local
/// offset cannot be determined.
pub fn local_log_timestamp() -> String {
    format_log(OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc()))
}

fn ymd(t: OffsetDateTime) -> String {
    format!("{:04}-{:02}-{:02}", t.year(), u8::from(t.month()), t.day())
}

fn hms(t: OffsetDateTime) -> String {
    format!("{:02}:{:02}:{:02}", t.hour(), t.minute(), t.second())
}

/// chrono's `to_rfc3339()` shape: 0, 3, 6 or 9 fractional digits (the fewest
/// that are exact) and a `±HH:MM` offset, `+00:00` rather than `Z` for UTC.
fn format_datetime(t: OffsetDateTime) -> String {
    let ns = t.nanosecond();
    let frac = if ns == 0 {
        String::new()
    } else if ns.is_multiple_of(1_000_000) {
        format!(".{:03}", ns / 1_000_000)
    } else if ns.is_multiple_of(1_000) {
        format!(".{:06}", ns / 1_000)
    } else {
        format!(".{ns:09}")
    };
    let off = t.offset().whole_seconds();
    let sign = if off < 0 { '-' } else { '+' };
    let off = off.unsigned_abs();
    format!(
        "{}T{}{frac}{sign}{:02}:{:02}",
        ymd(t),
        hms(t),
        off / 3_600,
        off / 60 % 60
    )
}

fn format_secs_z(t: OffsetDateTime) -> String {
    format!("{}T{}Z", ymd(t), hms(t))
}

fn format_log(t: OffsetDateTime) -> String {
    format!("{} {}", ymd(t), hms(t))
}

#[cfg(test)]
fn at(unix_nanos: i128, offset_secs: i32) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(unix_nanos)
        .unwrap()
        .to_offset(time::UtcOffset::from_whole_seconds(offset_secs).unwrap())
}

#[cfg(test)]
fn format_rfc3339(unix_nanos: i128, offset_secs: i32) -> String {
    format_datetime(at(unix_nanos, offset_secs))
}

#[cfg(test)]
fn format_rfc3339_secs_z(unix_secs: i64) -> String {
    format_secs_z(at(i128::from(unix_secs) * 1_000_000_000, 0))
}

#[cfg(test)]
fn format_log_timestamp(unix_secs: i64, offset_secs: i32) -> String {
    format_log(at(i128::from(unix_secs) * 1_000_000_000, offset_secs))
}

/// `ms` as the [`now_rfc3339`] shape, in UTC (test fixtures).
#[cfg(test)]
pub fn rfc3339_from_millis(ms: i64) -> String {
    format_rfc3339(ms as i128 * 1_000_000, 0)
}

/// `ms` as the [`now_rfc3339`] shape, at a fixed offset (test fixtures).
#[cfg(test)]
pub fn rfc3339_from_millis_at(ms: i64, offset_secs: i32) -> String {
    format_rfc3339(ms as i128 * 1_000_000, offset_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 2026-10-16T12:00:00Z.
    const T: i64 = 1_792_152_000_000;

    #[test]
    fn epoch_julian_day_is_1970_01_01() {
        assert_eq!(
            i64::from(OffsetDateTime::UNIX_EPOCH.date().to_julian_day()),
            UNIX_EPOCH_JULIAN_DAY
        );
    }

    // Pinned from chrono 0.4.45 `DateTime::parse_from_rfc3339(..).timestamp_millis()`
    // before the swap to `time` (#12126); the port was also fuzzed against chrono
    // (1M mutated strings, a 729k field grid) with no divergence before chrono
    // was removed. Caller verification fails closed on
    // `None`, so both the accepted and the refused sets are part of the contract.
    #[test]
    fn parse_accepts_what_chrono_accepted() {
        let cases: &[(&str, i64)] = &[
            ("2026-10-16T12:00:00Z", T),
            ("2026-10-16T12:00:00.000Z", T),
            ("2026-10-16t12:00:00z", T),
            ("2026-10-16 12:00:00Z", T),
            ("2026-10-16T14:00:00+02:00", T),
            ("2026-10-16T07:00:00-05:00", T),
            ("2026-10-16T12:00:00-00:00", T),
            ("2026-10-16T12:00:00+00:00", T),
            // U+2212 MINUS SIGN is accepted as an offset sign.
            ("2026-10-16T14:00:00\u{2212}02:00", T + 4 * 3_600_000),
            (
                "2026-10-16T12:00:00+23:59",
                T - (23 * 3600 + 59 * 60) * 1000,
            ),
            ("2026-10-16T12:00:00.5+01:30", T - 5_400_000 + 500),
            ("2026-10-16T12:00:00.1Z", T + 100),
            ("2026-10-16T12:00:00.123456789Z", T + 123),
            // Sub-millisecond digits truncate, never round; past 9 digits they
            // are skipped.
            ("2026-10-16T12:00:00.9999Z", T + 999),
            ("2026-10-16T12:00:00.1239999999999Z", T + 123),
            // Leap second 60 is accepted at any minute and rolls forward.
            ("2026-10-16T23:59:60Z", 1_792_195_200_000),
            ("2026-10-16T12:30:60.5Z", 1_792_153_860_500),
            ("2026-10-16T12:00:60Z", 1_792_152_060_000),
            ("2024-02-29T00:00:00Z", 1_709_164_800_000),
            ("0000-01-01T00:00:00Z", -62_167_219_200_000),
            ("9999-12-31T23:59:59.999Z", 253_402_300_799_999),
            ("1969-12-31T23:59:59.5Z", -500),
            // Leap second, fraction and offset together: roll, then subtract.
            ("2026-10-16T23:59:60.25-23:59", 1_792_281_540_250),
            ("2000-02-29T00:00:00Z", 951_782_400_000),
            // Year 0 is a leap year (proleptic Gregorian).
            ("0000-02-29T00:00:00Z", -62_162_121_600_000),
            // The `toISOString()` shape the API sends.
            ("2026-10-16T12:00:00.000+00:00", T),
        ];
        for (input, want) in cases {
            assert_eq!(parse_rfc3339_millis(input), Some(*want), "input {input:?}");
        }
    }

    #[test]
    fn parse_refuses_what_chrono_refused() {
        let cases: &[&str] = &[
            "",
            "tomorrow",
            "2026-10-16",
            "2026-10-16T12:00:00",
            "2026-10-16T12:00Z",
            "2026-13-01T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-10-00T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2025-02-29T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "2026-10-16T24:00:00Z",
            "2026-10-16T12:60:00Z",
            "2026-10-16T12:00:61Z",
            "2026-10-16T12:00:00+24:00",
            "2026-10-16T12:00:00+99:00",
            "2026-10-16T12:00:00+02:60",
            "2026-10-16T12:00:00+0200",
            "2026-10-16T12:00:00+02",
            "2026-10-16T12:00:00+02:0",
            "2026-10-16T12:00:00+2:00",
            "2026-10-16T12:00:00+02:00:00",
            "2026-10-16T12:00:00UTC",
            "2026-10-16T12:00:00GMT+1",
            "2026-10-16T12:00:00.Z",
            "2026-10-16T12:00:00.",
            "2026-10-16T12:00:00.5",
            "2026-10-16T12:00:00,5Z",
            "2026-10-16T12:00:00Z ",
            " 2026-10-16T12:00:00Z",
            "2026-10-16T12:00:00ZZ",
            "2026-10-16T12:00:00Z\n",
            "2026-10-16X12:00:00Z",
            "2026-10-16\t12:00:00Z",
            "2026-10-16TT12:00:00Z",
            "+2026-10-16T12:00:00Z",
            "-2026-10-16T12:00:00Z",
            "12026-10-16T12:00:00Z",
            "2026/10/16T12:00:00Z",
            "2026-10-16T12.00.00Z",
            "2026-1-16T12:00:00Z",
            "\u{ff12}026-10-16T12:00:00Z",
            "2026-10-16T12:00:00\u{2013}02:00",
            "2026-10-16T12:00:00\u{2212}",
            "2026-10-16T12:00:00+",
            "2026-10-16T12:00:00 +02:00",
            "2100-02-29T00:00:00Z",
            "2026-10-16T12:00:00-24:00",
            "2026-10-16T12:00:00\u{2212}24:00",
            "2026-10-16T12:00:00+02:99",
            "2026-10-16T12:00:00+0a:00",
            "2026-10-16T12:00:00+02:0a",
            // Multi-byte UTF-8 around every slicing point: refused, no panic.
            "2026-10-16T12:00:00\u{e9}",
            "2026-10-16T12:00:00.\u{e9}",
            "2026-10-16T12:00:00+0\u{e9}:00",
            "2026-10-16T\u{e9}2:00:00Z",
            "2026-10-16T12:00:0\u{e9}Z",
        ];
        for input in cases {
            assert_eq!(parse_rfc3339_millis(input), None, "input {input:?}");
        }
    }

    // Pinned from chrono's `to_rfc3339()`: `+HH:MM` offset (never `Z`) and
    // 0, 3, 6 or 9 fractional digits.
    #[test]
    fn format_rfc3339_matches_chrono_to_rfc3339() {
        let s = T as i128 * 1_000_000;
        assert_eq!(format_rfc3339(s, 0), "2026-10-16T12:00:00+00:00");
        assert_eq!(
            format_rfc3339(s + 120_000_000, 0),
            "2026-10-16T12:00:00.120+00:00"
        );
        assert_eq!(
            format_rfc3339(s + 123_456_000, 0),
            "2026-10-16T12:00:00.123456+00:00"
        );
        assert_eq!(
            format_rfc3339(s + 123_456_789, 0),
            "2026-10-16T12:00:00.123456789+00:00"
        );
        assert_eq!(
            format_rfc3339(s + 1, 0),
            "2026-10-16T12:00:00.000000001+00:00"
        );
        assert_eq!(
            format_rfc3339(s + 1_000, 0),
            "2026-10-16T12:00:00.000001+00:00"
        );
        assert_eq!(format_rfc3339(s, 7200), "2026-10-16T14:00:00+02:00");
        assert_eq!(
            format_rfc3339(s, -(5 * 3600 + 30 * 60)),
            "2026-10-16T06:30:00-05:30"
        );
        assert_eq!(
            format_rfc3339(-500_000_000, 0),
            "1969-12-31T23:59:59.500+00:00"
        );
        assert_eq!(rfc3339_from_millis(T + 7), "2026-10-16T12:00:00.007+00:00");
        assert_eq!(rfc3339_from_millis_at(T, 7200), "2026-10-16T14:00:00+02:00");
    }

    #[test]
    fn format_secs_z_matches_chrono_secs_utc() {
        assert_eq!(format_rfc3339_secs_z(T / 1000), "2026-10-16T12:00:00Z");
        assert_eq!(format_rfc3339_secs_z(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn format_log_timestamp_is_local_wall_clock() {
        assert_eq!(format_log_timestamp(T / 1000, 0), "2026-10-16 12:00:00");
        assert_eq!(format_log_timestamp(T / 1000, 7200), "2026-10-16 14:00:00");
        assert_eq!(
            format_log_timestamp(T / 1000, -14 * 3600),
            "2026-10-15 22:00:00"
        );
    }

    #[test]
    fn now_helpers_round_trip_through_the_parser() {
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let full = now_rfc3339();
        assert!(full.ends_with("+00:00"), "{full}");
        assert!(
            (parse_rfc3339_millis(&full).unwrap() - wall).abs() < 5_000,
            "{full}"
        );
        let secs = now_rfc3339_secs();
        assert_eq!(secs.len(), 20, "{secs}");
        assert!(secs.ends_with('Z'), "{secs}");
        assert!(
            (parse_rfc3339_millis(&secs).unwrap() - wall).abs() < 5_000,
            "{secs}"
        );
        let log = local_log_timestamp();
        assert_eq!(log.len(), 19, "{log}");
        assert_eq!(log.as_bytes()[10], b' ', "{log}");
    }
}
