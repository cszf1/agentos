//! Minimal libpam binding for the gateway's local administrator re-authentication (spec §7.2, §12.2). The password
//! arrives on the protected native frame, is answered to PAM's conversation once, and is zeroed; it never reaches
//! argv, logs, the machine database or any model context.
use std::ffi::{c_char, c_int, c_void, CStr, CString};

#[repr(C)]
struct PamMessage {
    msg_style: c_int,
    msg: *const c_char,
}
#[repr(C)]
struct PamResponse {
    resp: *mut c_char,
    resp_retcode: c_int,
}
#[repr(C)]
struct PamConv {
    conv: extern "C" fn(c_int, *mut *const PamMessage, *mut *mut PamResponse, *mut c_void) -> c_int,
    appdata: *mut c_void,
}

#[link(name = "pam")]
extern "C" {
    fn pam_start(service: *const c_char, user: *const c_char, conv: *const PamConv, handle: *mut *mut c_void) -> c_int;
    fn pam_authenticate(h: *mut c_void, flags: c_int) -> c_int;
    fn pam_acct_mgmt(h: *mut c_void, flags: c_int) -> c_int;
    fn pam_end(h: *mut c_void, status: c_int) -> c_int;
}

const PAM_PROMPT_ECHO_OFF: c_int = 1;
const PAM_SUCCESS: c_int = 0;
const PAM_CONV_ERR: c_int = 19;
const PAM_DISALLOW_NULL_AUTHTOK: c_int = 0x1;

extern "C" fn conv(n: c_int, msgs: *mut *const PamMessage, resp: *mut *mut PamResponse, data: *mut c_void) -> c_int {
    unsafe {
        let pw = &*(data as *const CString);
        let out = libc::calloc(n as usize, std::mem::size_of::<PamResponse>()) as *mut PamResponse;
        if out.is_null() {
            return PAM_CONV_ERR;
        }
        for i in 0..n as isize {
            let m = *msgs.offset(i);
            if (*m).msg_style == PAM_PROMPT_ECHO_OFF {
                (*out.offset(i)).resp = libc::strdup(pw.as_ptr());
            }
        }
        *resp = out;
    }
    PAM_SUCCESS
}

pub fn authenticate(service: &str, user: &str, password: &mut Vec<u8>) -> bool {
    let pw = match CString::new(password.clone()) {
        Ok(c) => c,
        Err(_) => return false,
    };
    password.iter_mut().for_each(|b| *b = 0);
    let (svc, usr) = match (CString::new(service), CString::new(user)) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return false,
    };
    let c = PamConv { conv, appdata: &pw as *const CString as *mut c_void };
    let mut h: *mut c_void = std::ptr::null_mut();
    unsafe {
        if pam_start(svc.as_ptr(), usr.as_ptr(), &c, &mut h) != PAM_SUCCESS {
            return false;
        }
        let mut rc = pam_authenticate(h, PAM_DISALLOW_NULL_AUTHTOK);
        if rc == PAM_SUCCESS {
            rc = pam_acct_mgmt(h, 0);
        }
        pam_end(h, rc);
        let raw = pw.into_raw();
        let len = CStr::from_ptr(raw).to_bytes().len();
        std::ptr::write_bytes(raw, 0, len);
        drop(CString::from_raw(raw));
        rc == PAM_SUCCESS
    }
}
