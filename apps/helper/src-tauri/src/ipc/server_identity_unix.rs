//! Broker-server verification for the Assist client's Unix socket (#12117).
//!
//! Before the client sends anything — including the identity-bearing
//! `auth_request` — it proves that whoever accepted the connection is the
//! root broker. Same rule as the Go clients
//! (`agent/internal/ipc/serveridentity_unix.go`, `serveridentity_linux.go`):
//!   - the server end's kernel uid (SO_PEERCRED) is 0, and
//!   - every directory from the socket's canonical parent up to `/` is a
//!     root-owned directory others cannot write. Group write is refused too,
//!     except on the socket's own directory when its group is root's or the
//!     IPC group (the shipped install creates `/run/breeze` 0770 root:breeze).
//!
//! The decision ([`check_unix_server_identity`]) is pure data so it is
//! unit-tested on every host. Only the evidence gathering is Linux-specific;
//! like the Go clients, macOS keeps its existing trust model for now.

use std::fmt;

/// Group the shipped install gives the broker's socket and, on Linux, its
/// directory (Go `ipc.IPCGroupName`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const IPC_GROUP_NAME: &str = "breeze";

/// One directory on the canonical path to the socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEvidence {
    pub path: String,
    pub uid: u32,
    pub gid: u32,
    /// Permission bits only (`st_mode & 0o777`).
    pub perm: u32,
    /// Whether the entry is a directory (not a symlink or anything else).
    pub is_dir: bool,
}

/// What an unprivileged client can learn about whoever accepted its
/// connection on a Unix socket.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnixServerEvidence {
    /// Kernel-reported uid of the server end (SO_PEERCRED).
    pub peer_uid: u32,
    /// Every directory from the socket's canonical parent up to `/`: the
    /// socket directory first, `/` last.
    pub dir_chain: Vec<DirEvidence>,
    /// Groups, besides root's (gid 0), that may hold write access to the
    /// socket's own directory: the IPC group, when it resolves.
    pub trusted_group_ids: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnixServerIdentityError {
    /// The server end does not run as uid 0, so it cannot be the broker.
    NotRoot(u32),
    /// A directory on the socket's path could have been changed by a
    /// non-root user, or the evidence is incomplete.
    DirUnsafe(String),
}

impl fmt::Display for UnixServerIdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotRoot(uid) => write!(f, "unix socket server is not root: peer uid {uid}"),
            Self::DirUnsafe(why) => {
                write!(f, "unix socket directory is not root-controlled: {why}")
            }
        }
    }
}

impl std::error::Error for UnixServerIdentityError {}

/// Decides whether a Unix socket server is the root broker. Fails closed on
/// missing evidence.
///
/// uid 0 proves the server is privileged, not specifically that it is
/// Breeze: an unprivileged client cannot read `/proc/<pid>/exe` of a root
/// process, so this is the strongest anchor it has, and it stops a non-root
/// impostor.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn check_unix_server_identity(ev: &UnixServerEvidence) -> Result<(), UnixServerIdentityError> {
    use UnixServerIdentityError::{DirUnsafe, NotRoot};
    if ev.peer_uid != 0 {
        return Err(NotRoot(ev.peer_uid));
    }
    let Some(last) = ev.dir_chain.last() else {
        return Err(DirUnsafe("no directory evidence".into()));
    };
    for (i, d) in ev.dir_chain.iter().enumerate() {
        if !d.is_dir {
            return Err(DirUnsafe(format!("{} is not a directory", d.path)));
        }
        if d.uid != 0 {
            return Err(DirUnsafe(format!("{} is owned by uid {}", d.path, d.uid)));
        }
        if d.perm & 0o002 != 0 {
            return Err(DirUnsafe(format!(
                "{} is writable by others (mode {:o})",
                d.path, d.perm
            )));
        }
        let trusted_group = d.gid == 0 || ev.trusted_group_ids.contains(&d.gid);
        if d.perm & 0o020 != 0 && (i != 0 || !trusted_group) {
            return Err(DirUnsafe(format!(
                "{} is writable by group {} (mode {:o})",
                d.path, d.gid, d.perm
            )));
        }
    }
    if last.path != "/" {
        return Err(DirUnsafe(format!(
            "directory evidence stops at {}, not /",
            last.path
        )));
    }
    Ok(())
}

/// Collects what [`check_unix_server_identity`] decides on: the server end's
/// kernel uid and the owner and mode of every directory from the socket's
/// canonical parent up to `/`. Symlinks in the socket path are resolved
/// first, so `/var/run` is checked as `/run`.
#[cfg(target_os = "linux")]
pub fn gather_unix_server_evidence(
    stream: &tokio::net::UnixStream,
    socket_path: &str,
) -> std::io::Result<UnixServerEvidence> {
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    let peer_uid = stream.peer_cred()?.uid();
    let parent = match Path::new(socket_path).parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let dir = std::fs::canonicalize(parent)?;
    let mut ev = UnixServerEvidence {
        peer_uid,
        // An unresolvable IPC group only narrows what is trusted: the socket
        // dir is then accepted group-writable for root's group alone.
        trusted_group_ids: lookup_group_gid(IPC_GROUP_NAME).into_iter().collect(),
        ..Default::default()
    };
    let mut p: &Path = &dir;
    loop {
        let md = std::fs::symlink_metadata(p)?;
        ev.dir_chain.push(DirEvidence {
            path: p.to_string_lossy().into_owned(),
            uid: md.uid(),
            gid: md.gid(),
            perm: md.mode() & 0o777,
            is_dir: md.file_type().is_dir(),
        });
        match p.parent() {
            Some(up) => p = up,
            None => break, // reached "/"
        }
    }
    Ok(ev)
}

/// Checks, before anything is sent, that the process that accepted `stream`
/// on `socket_path` is the root broker. Any failure — including being unable
/// to gather the evidence — is a refusal.
#[cfg(target_os = "linux")]
pub fn verify_unix_broker_server(
    stream: &tokio::net::UnixStream,
    socket_path: &str,
) -> Result<(), String> {
    let ev = gather_unix_server_evidence(stream, socket_path)
        .map_err(|e| format!("cannot verify broker socket server: {e}"))?;
    check_unix_server_identity(&ev).map_err(|e| e.to_string())
}

/// Resolves a group name to its gid with the reentrant `getgrnam_r`.
#[cfg(target_os = "linux")]
fn lookup_group_gid(name: &str) -> Option<u32> {
    let cname = std::ffi::CString::new(name).ok()?;
    let mut len = 4096usize;
    loop {
        let mut buf = vec![0 as libc::c_char; len];
        // SAFETY: zeroed is a valid bit pattern for this plain C struct; it is
        // only read after getgrnam_r reports success.
        let mut grp: libc::group = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::group = std::ptr::null_mut();
        // SAFETY: every pointer is valid for the duration of the call and
        // `buf.len()` is the true size of `buf`.
        let rc = unsafe {
            libc::getgrnam_r(
                cname.as_ptr(),
                &mut grp,
                buf.as_mut_ptr(),
                buf.len(),
                &mut result,
            )
        };
        if rc == libc::ERANGE && len < (1 << 20) {
            len *= 4;
            continue;
        }
        if rc != 0 || result.is_null() {
            return None;
        }
        return Some(grp.gr_gid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(path: &str, gid: u32, perm: u32) -> DirEvidence {
        DirEvidence {
            path: path.into(),
            uid: 0,
            gid,
            perm,
            is_dir: true,
        }
    }

    fn root_chain() -> Vec<DirEvidence> {
        vec![
            dir("/run/breeze", 0, 0o755),
            dir("/run", 0, 0o755),
            dir("/", 0, 0o755),
        ]
    }

    fn ev(peer_uid: u32, dir_chain: Vec<DirEvidence>, trusted: &[u32]) -> UnixServerEvidence {
        UnixServerEvidence {
            peer_uid,
            dir_chain,
            trusted_group_ids: trusted.to_vec(),
        }
    }

    const BREEZE_GID: u32 = 987;

    fn assert_dir_unsafe(r: Result<(), UnixServerIdentityError>) {
        assert!(
            matches!(r, Err(UnixServerIdentityError::DirUnsafe(_))),
            "got {r:?}, want DirUnsafe"
        );
    }

    #[test]
    fn accepts_root_server_in_root_dirs() {
        assert_eq!(
            check_unix_server_identity(&ev(0, root_chain(), &[])),
            Ok(())
        );
    }

    #[test]
    fn rejects_non_root_peer() {
        assert_eq!(
            check_unix_server_identity(&ev(1000, root_chain(), &[])),
            Err(UnixServerIdentityError::NotRoot(1000))
        );
    }

    #[test]
    fn rejects_missing_dir_evidence() {
        assert_dir_unsafe(check_unix_server_identity(&ev(0, vec![], &[])));
    }

    /// The shipped install creates /run/breeze 0770 root:breeze (systemd
    /// RuntimeDirectoryMode, tmpfiles.d, the installer); the agent narrows it
    /// to 0755 when it starts listening. Every real shape must verify.
    #[test]
    fn accepts_shipped_socket_dir_modes() {
        for (gid, perm) in [(BREEZE_GID, 0o770), (0, 0o770), (BREEZE_GID, 0o755)] {
            let mut chain = root_chain();
            chain[0].gid = gid;
            chain[0].perm = perm;
            assert_eq!(
                check_unix_server_identity(&ev(0, chain, &[BREEZE_GID])),
                Ok(()),
                "gid {gid} perm {perm:o}"
            );
        }
    }

    #[test]
    fn rejects_socket_dir_writable_by_untrusted_group() {
        let mut chain = root_chain();
        chain[0].gid = 100;
        chain[0].perm = 0o770;
        assert_dir_unsafe(check_unix_server_identity(&ev(0, chain, &[BREEZE_GID])));
    }

    #[test]
    fn rejects_group_writable_ancestor() {
        let mut chain = root_chain();
        chain[1].perm = 0o775;
        assert_dir_unsafe(check_unix_server_identity(&ev(0, chain, &[0])));
    }

    #[test]
    fn rejects_world_writable_socket_dir() {
        let mut chain = root_chain();
        chain[0].perm = 0o777;
        assert_dir_unsafe(check_unix_server_identity(&ev(0, chain, &[0])));
    }

    #[test]
    fn rejects_non_root_owned_dir() {
        let mut chain = root_chain();
        chain[1].uid = 1000;
        assert_dir_unsafe(check_unix_server_identity(&ev(0, chain, &[])));
    }

    #[test]
    fn rejects_non_directory_entry() {
        let mut chain = root_chain();
        chain[0].is_dir = false;
        assert_dir_unsafe(check_unix_server_identity(&ev(0, chain, &[])));
    }

    #[test]
    fn rejects_chain_that_stops_short_of_root() {
        let mut chain = root_chain();
        chain.pop();
        assert_dir_unsafe(check_unix_server_identity(&ev(0, chain, &[])));
    }

    /// Real socket: a server this test runs (not root, or root inside the
    /// world-writable temp dir) must be refused, and the gathered evidence
    /// must carry the kernel peer uid and a full chain up to `/`.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn verify_refuses_a_server_that_is_not_the_broker() {
        let dir =
            std::env::temp_dir().join(format!("breeze-sid-{}-{}", std::process::id(), line!()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("agent.sock");
        let sock_str = sock.to_str().unwrap().to_string();
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        let accept = tokio::spawn(async move { listener.accept().await.map(|(s, _)| s) });
        let stream = tokio::net::UnixStream::connect(&sock).await.unwrap();
        let _server = accept.await.unwrap().unwrap();

        let ev = gather_unix_server_evidence(&stream, &sock_str).unwrap();
        assert_eq!(ev.peer_uid, unsafe { libc::getuid() });
        assert_eq!(
            ev.dir_chain.first().unwrap().path,
            std::fs::canonicalize(&dir).unwrap().to_string_lossy()
        );
        assert_eq!(ev.dir_chain.last().unwrap().path, "/");

        let r = verify_unix_broker_server(&stream, &sock_str);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(r.is_err(), "a non-broker server was accepted: {ev:?}");
    }
}
