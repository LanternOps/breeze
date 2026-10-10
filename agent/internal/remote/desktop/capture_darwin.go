//go:build darwin && cgo

package desktop

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation -framework AppKit -framework CoreMedia -framework CoreVideo -framework Accelerate
// ScreenCaptureKit is resolved entirely at runtime. We intentionally do not
// weak-link the framework so local builds do not depend on CGO_LDFLAGS_ALLOW.

#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <AppKit/AppKit.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <Accelerate/Accelerate.h>
#include <os/lock.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/sysctl.h>
#include <dlfcn.h>
#include <objc/runtime.h>
#include <objc/message.h>

// darwinMajorVersion returns the Darwin kernel major version.
// Darwin 23 = macOS 14 (Sonoma), 22 = macOS 13 (Ventura), 21 = macOS 12 (Monterey).
int darwinMajorVersion(void) {
    char str[64] = {0};
    size_t size = sizeof(str);
    if (sysctlbyname("kern.osrelease", str, &size, NULL, 0) != 0) {
        return 0;
    }
    int major = 0;
    sscanf(str, "%d", &major);
    return major;
}

// ---- ScreenCaptureKit path (macOS 14+) ----
// All SCK classes are resolved at runtime via NSClassFromString to avoid
// hard dyld symbol references on macOS 12-13 where SCK doesn't exist.
// The framework is NOT linked; classes are loaded dynamically.

// Cached ScreenCaptureKit objects (typed as id to avoid compile-time class refs).
// Touched only from the capture goroutine, which darwinCaptureMu + the Go
// capturer's mutex serialise.
static id g_filter = nil;
static id g_config = nil;
static CGDirectDisplayID g_displayID = 0;

static int loadDisplayFromShareableContent(id content, int displayIndex, CGDirectDisplayID preferID, id *outDisplay) {
    if (content == nil || outDisplay == nil) return 2;

    NSArray *displays = [content valueForKey:@"displays"];
    if (displays == nil) {
        return 2;
    }
    // #4042: zero displays is NOT the same failure as a content request that
    // errored. Nothing is attached to capture — no permission change can fix
    // it. Reporting 2 here made the two indistinguishable in the Go error.
    if (displays.count == 0) {
        return 11;
    }

    // A stream rebuild (#5928) prefers the display it was already capturing:
    // plugging in a second monitor can reorder the list under a fixed index.
    if (preferID != 0) {
        for (id d in displays) {
            NSNumber *num = [d valueForKey:@"displayID"];
            if (num != nil && [num unsignedIntValue] == preferID) {
                *outDisplay = d;
                return 0;
            }
        }
    }

    NSUInteger idx = (NSUInteger)displayIndex;
    if (idx >= displays.count) idx = 0;
    *outDisplay = displays[idx];
    return 0;
}

static int fetchShareableContentDisplay(id shareableContentClass, SEL sel, BOOL useFlags, BOOL excludeDesktopWindows, BOOL onScreenWindowsOnly, int displayIndex, CGDirectDisplayID preferID, id *outDisplay) {
    if (shareableContentClass == nil || sel == NULL || outDisplay == nil) return 8;

    __block int error = 0;
    __block id content = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    if (useFlags) {
        void (*sendMsg)(id, SEL, BOOL, BOOL, void(^)(id, NSError*)) = (void*)objc_msgSend;
        sendMsg(shareableContentClass, sel, excludeDesktopWindows, onScreenWindowsOnly, ^(id shareableContent, NSError* err) {
            if (err != nil || shareableContent == nil) {
                error = 2;
            } else {
                content = shareableContent;
            }
            dispatch_semaphore_signal(sem);
        });
    } else {
        void (*sendMsg)(id, SEL, void(^)(id, NSError*)) = (void*)objc_msgSend;
        sendMsg(shareableContentClass, sel, ^(id shareableContent, NSError* err) {
            if (err != nil || shareableContent == nil) {
                error = 2;
            } else {
                content = shareableContent;
            }
            dispatch_semaphore_signal(sem);
        });
    }

    long timedOut = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10LL * NSEC_PER_SEC));
    if (timedOut != 0) return 7;
    if (error != 0) return error;

    return loadDisplayFromShareableContent(content, displayIndex, preferID, outDisplay);
}

// isSCKAvailable checks if ScreenCaptureKit classes can be loaded at runtime.
static void ensureSCKLoaded(void) {
    static int attempted = 0;
    if (attempted) return;
    attempted = 1;
    dlopen("/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit", RTLD_LAZY | RTLD_LOCAL);
}

static int isSCKAvailable(void) {
    ensureSCKLoaded();
    return NSClassFromString(@"SCShareableContent") != nil;
}

// sckBuildFilter queries SCShareableContent and builds the content filter for
// the target display. configureOutput also builds the stream configuration;
// a rebuild (#5928) passes 0 and keeps the original configuration, so the
// output size the encoder was initialised with never changes mid-session —
// SCK scales the display into it, as the per-frame screenshot path did.
static int sckBuildFilter(int displayIndex, CGDirectDisplayID preferID, int configureOutput) {
    if (!isSCKAvailable()) return 8; // SCK not available on this macOS version

    Class SCShareableContentClass = NSClassFromString(@"SCShareableContent");
    id targetDisplay = nil;
    int error = 2;

    SEL currentProcessSel = NSSelectorFromString(@"getCurrentProcessShareableContentWithCompletionHandler:");
    if ([(id)SCShareableContentClass respondsToSelector:currentProcessSel]) {
        error = fetchShareableContentDisplay(SCShareableContentClass, currentProcessSel, NO, NO, NO, displayIndex, preferID, &targetDisplay);
    }

    if (targetDisplay == nil) {
        SEL filteredSel = NSSelectorFromString(@"getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:");
        error = fetchShareableContentDisplay(SCShareableContentClass, filteredSel, YES, NO, YES, displayIndex, preferID, &targetDisplay);
    }

    if (targetDisplay == nil) {
        SEL currentSel = NSSelectorFromString(@"getShareableContentWithCompletionHandler:");
        error = fetchShareableContentDisplay(SCShareableContentClass, currentSel, NO, NO, NO, displayIndex, preferID, &targetDisplay);
    }

    if (error != 0 || targetDisplay == nil) return error != 0 ? error : 2;

    NSNumber *displayIDNum = [targetDisplay valueForKey:@"displayID"];
    CGDirectDisplayID targetID = [displayIDNum unsignedIntValue];

    Class SCContentFilterClass = NSClassFromString(@"SCContentFilter");

    // [[SCContentFilter alloc] initWithDisplay:excludingWindows:]
    #pragma clang diagnostic push
    #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id filter = [[SCContentFilterClass alloc] performSelector:NSSelectorFromString(@"initWithDisplay:excludingWindows:")
                                                  withObject:targetDisplay
                                                  withObject:@[]];
    #pragma clang diagnostic pop
    if (filter == nil) return 2;

    if (configureOutput || g_config == nil) {
        CGFloat scaleFactor = 1.0;
        for (NSScreen *screen in [NSScreen screens]) {
            NSNumber *screenNum = screen.deviceDescription[@"NSScreenNumber"];
            if (screenNum && [screenNum unsignedIntValue] == targetID) {
                scaleFactor = [screen backingScaleFactor];
                break;
            }
        }

        Class SCStreamConfigClass = NSClassFromString(@"SCStreamConfiguration");
        id config = [[SCStreamConfigClass alloc] init];
        if (config == nil) return 8;

        NSNumber *widthNum = [targetDisplay valueForKey:@"width"];
        NSNumber *heightNum = [targetDisplay valueForKey:@"height"];
        [config setValue:@((size_t)([widthNum doubleValue] * scaleFactor)) forKey:@"width"];
        [config setValue:@((size_t)([heightNum doubleValue] * scaleFactor)) forKey:@"height"];
        [config setValue:@YES forKey:@"showsCursor"];
        // Stream settings (#5928). BGRA is converted to the RGBA the encoder
        // expects in sckCopyFrameRGBA. sRGB matches what the old
        // CGBitmapContext (DeviceRGB) path produced instead of passing the
        // display's native (e.g. P3) values through as if they were sRGB.
        [config setValue:@((unsigned int)kCVPixelFormatType_32BGRA) forKey:@"pixelFormat"];
        // colorSpaceName is a CFStringRef property, which KVC cannot set:
        // setValue:forKey: throws NSUnknownKeyException on every OS and the
        // uncaught exception aborts the process. Call the setter directly.
        SEL csnSel = NSSelectorFromString(@"setColorSpaceName:");
        if ([config respondsToSelector:csnSel]) {
            void (*setCSN)(id, SEL, CFStringRef) = (void*)objc_msgSend;
            setCSN(config, csnSel, kCGColorSpaceSRGB);
        }
        // Cap delivery at the session's maximum frame rate (maxFrameRate=60).
        SEL mfiSel = NSSelectorFromString(@"setMinimumFrameInterval:");
        if ([config respondsToSelector:mfiSel]) {
            void (*setMFI)(id, SEL, CMTime) = (void*)objc_msgSend;
            setMFI(config, mfiSel, CMTimeMake(1, 60));
        }
        // Surfaces SCK may have in flight. We hold at most two (the slot and
        // the one being copied), so 5 leaves SCK three to render into.
        [config setValue:@5 forKey:@"queueDepth"];
        g_config = config;
    }

    g_filter = filter;
    g_displayID = targetID;
    return 0;
}

// ---- SCStream latest-frame slot (#5928) ----
// SCK delivers frames on g_sampleQueue into g_latestFrame; the Go capturer
// copies the slot on demand, so capture never blocks the encode loop.
// g_streamGen fences callbacks from a stream that has been stopped: every
// start and stop bumps it, and a callback whose output object carries an
// older generation is dropped.
static os_unfair_lock g_slotLock = OS_UNFAIR_LOCK_INIT;
static CVPixelBufferRef g_latestFrame = NULL; // guarded by g_slotLock
static uint64_t g_frameSeq = 0;               // guarded; never reset
static uint64_t g_streamGen = 0;              // guarded
static int g_streamStopped = 0;               // guarded
static long g_streamStopCode = 0;             // guarded

static id g_stream = nil;        // SCStream
static id g_streamOutput = nil;  // BreezeSCKStreamOutput
static dispatch_queue_t g_sampleQueue = NULL;
static size_t g_modePixelWidth = 0;
static size_t g_modePixelHeight = 0;

// SCFrameStatusComplete. Other statuses (idle, blank, suspended, started,
// stopped) carry no new screen content.
#define BREEZE_SC_FRAME_STATUS_COMPLETE 0
// SCStreamErrorUserDeclined: the user has not granted Screen Recording.
#define BREEZE_SC_ERROR_USER_DECLINED (-3801)

static BOOL sckSampleIsCompleteFrame(CMSampleBufferRef sampleBuffer) {
    static NSString *statusKey = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString * __unsafe_unretained *sym = (NSString * __unsafe_unretained *)dlsym(RTLD_DEFAULT, "SCStreamFrameInfoStatus");
        if (sym != NULL) statusKey = *sym;
    });
    if (statusKey == nil) return YES; // cannot tell; rely on the image buffer check

    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
    if (attachments == NULL || CFArrayGetCount(attachments) == 0) return NO;
    NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    NSNumber *status = info[statusKey];
    if (status == nil) return NO;
    return [status integerValue] == BREEZE_SC_FRAME_STATUS_COMPLETE;
}

@interface BreezeSCKStreamOutput : NSObject
@property (nonatomic, assign) uint64_t generation;
@end

@implementation BreezeSCKStreamOutput
// SCStreamOutput. type 0 = SCStreamOutputTypeScreen.
- (void)stream:(id)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(NSInteger)type {
    if (type != 0 || sampleBuffer == NULL || !CMSampleBufferIsValid(sampleBuffer)) return;
    if (!sckSampleIsCompleteFrame(sampleBuffer)) return;
    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (imageBuffer == NULL) return;

    CVPixelBufferRef incoming = CVPixelBufferRetain(imageBuffer);
    CVPixelBufferRef toRelease = incoming;
    os_unfair_lock_lock(&g_slotLock);
    if (self.generation == g_streamGen) {
        toRelease = g_latestFrame;
        g_latestFrame = incoming;
        g_frameSeq++;
    }
    os_unfair_lock_unlock(&g_slotLock);
    if (toRelease != NULL) CVPixelBufferRelease(toRelease);
}

// SCStreamDelegate.
- (void)stream:(id)stream didStopWithError:(NSError *)error {
    os_unfair_lock_lock(&g_slotLock);
    if (self.generation == g_streamGen) {
        g_streamStopped = 1;
        g_streamStopCode = error != nil ? (long)error.code : 0;
    }
    os_unfair_lock_unlock(&g_slotLock);
}
@end

// SCK is not linked, so the protocols the output object implements are only
// known at runtime. Declare conformance once the framework is loaded, in
// case SCStream checks it.
static void sckDeclareProtocols(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Class cls = [BreezeSCKStreamOutput class];
        Protocol *output = objc_getProtocol("SCStreamOutput");
        if (output != NULL) class_addProtocol(cls, output);
        Protocol *delegate = objc_getProtocol("SCStreamDelegate");
        if (delegate != NULL) class_addProtocol(cls, delegate);
    });
}

static void sckRecordDisplayMode(void) {
    g_modePixelWidth = 0;
    g_modePixelHeight = 0;
    if (g_displayID == 0) return;
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(g_displayID);
    if (mode == NULL) return;
    g_modePixelWidth = CGDisplayModeGetPixelWidth(mode);
    g_modePixelHeight = CGDisplayModeGetPixelHeight(mode);
    CGDisplayModeRelease(mode);
}

// sckStopStream stops and releases the current stream and empties the slot.
// Safe to call when nothing is running.
void sckStopStream(void) {
    CVPixelBufferRef old = NULL;
    os_unfair_lock_lock(&g_slotLock);
    g_streamGen++;
    old = g_latestFrame;
    g_latestFrame = NULL;
    g_streamStopped = 0;
    g_streamStopCode = 0;
    os_unfair_lock_unlock(&g_slotLock);
    if (old != NULL) CVPixelBufferRelease(old);

    id stream = g_stream;
    id output = g_streamOutput;
    g_stream = nil;
    g_streamOutput = nil;
    if (stream == nil) return;

    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    void (*stopCap)(id, SEL, void(^)(NSError*)) = (void*)objc_msgSend;
    stopCap(stream, NSSelectorFromString(@"stopCaptureWithCompletionHandler:"), ^(NSError *err) {
        dispatch_semaphore_signal(sem);
    });
    // A stream that already stopped on its own answers with an error at once;
    // bound the wait so teardown can never hang the capture goroutine.
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2LL * NSEC_PER_SEC));
    // Let any sample callback already queued run (the generation fence drops
    // it) before the last references to the output object and stream go.
    if (g_sampleQueue != NULL) {
        dispatch_sync(g_sampleQueue, ^{});
    }
    (void)output;
    stream = nil;
    output = nil;
}

// sckStartStream creates and starts an SCStream for the capturer's display.
// refreshFilter re-queries SCShareableContent first (a rebuild after a stop,
// a display change, or wake); the first start reuses the filter initCapture
// built. On failure *outNSErrorCode carries the SCStreamError code, if any.
int sckStartStream(int displayIndex, int refreshFilter, long *outNSErrorCode) {
    *outNSErrorCode = 0;
    sckStopStream();

    if (refreshFilter || g_filter == nil) {
        int rc = sckBuildFilter(displayIndex, g_displayID, 0);
        if (rc != 0) return rc;
    }
    if (g_filter == nil || g_config == nil) return 6;

    Class SCStreamClass = NSClassFromString(@"SCStream");
    if (SCStreamClass == nil) return 8;
    sckDeclareProtocols();

    if (g_sampleQueue == NULL) {
        g_sampleQueue = dispatch_queue_create("com.breeze.desktop.sckstream", DISPATCH_QUEUE_SERIAL);
        if (g_sampleQueue == NULL) return 12;
    }

    BreezeSCKStreamOutput *output = [[BreezeSCKStreamOutput alloc] init];
    os_unfair_lock_lock(&g_slotLock);
    g_streamGen++;
    output.generation = g_streamGen;
    g_streamStopped = 0;
    g_streamStopCode = 0;
    os_unfair_lock_unlock(&g_slotLock);

    // [[SCStream alloc] initWithFilter:configuration:delegate:]. Typed with
    // init-family ownership (consumes self, returns +1) so ARC does not
    // release the alloc'd object again if init fails and frees it.
    typedef id __attribute__((ns_returns_retained)) (*BreezeInitStreamFn)(id __attribute__((ns_consumed)), SEL, id, id, id);
    BreezeInitStreamFn initStream = (BreezeInitStreamFn)objc_msgSend;
    id stream = initStream([SCStreamClass alloc], NSSelectorFromString(@"initWithFilter:configuration:delegate:"),
                           g_filter, g_config, output);
    if (stream == nil) return 12;

    NSError * __autoreleasing addErr = nil;
    BOOL (*addOutput)(id, SEL, id, NSInteger, dispatch_queue_t, NSError * __autoreleasing *) = (void*)objc_msgSend;
    if (!addOutput(stream, NSSelectorFromString(@"addStreamOutput:type:sampleHandlerQueue:error:"),
                   output, (NSInteger)0, g_sampleQueue, &addErr)) {
        *outNSErrorCode = addErr != nil ? (long)addErr.code : 0;
        return 12;
    }

    // Hand ownership to the globals before starting, so any failure path
    // below tears the stream down through sckStopStream.
    g_stream = stream;
    g_streamOutput = output;

    __block long startErr = 0;
    __block int startFailed = 0;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    void (*startCap)(id, SEL, void(^)(NSError*)) = (void*)objc_msgSend;
    startCap(stream, NSSelectorFromString(@"startCaptureWithCompletionHandler:"), ^(NSError *err) {
        if (err != nil) {
            startFailed = 1;
            startErr = (long)err.code;
        }
        dispatch_semaphore_signal(sem);
    });
    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5LL * NSEC_PER_SEC)) != 0) {
        sckStopStream();
        return 7;
    }
    if (startFailed) {
        *outNSErrorCode = startErr;
        sckStopStream();
        return startErr == BREEZE_SC_ERROR_USER_DECLINED ? 3 : 12;
    }

    sckRecordDisplayMode();
    return 0;
}

uint64_t sckFrameSeq(void) {
    os_unfair_lock_lock(&g_slotLock);
    uint64_t seq = g_frameSeq;
    os_unfair_lock_unlock(&g_slotLock);
    return seq;
}

// sckStreamStopState reports whether SCK stopped the current stream on its
// own (display removed, sleep, permission revoked, ...), with the error code.
int sckStreamStopState(long *outCode) {
    os_unfair_lock_lock(&g_slotLock);
    int stopped = g_streamStopped;
    *outCode = g_streamStopCode;
    os_unfair_lock_unlock(&g_slotLock);
    return stopped;
}

// sckAcquireLatest returns the latest frame retained (release with
// sckReleaseFrame), or 0 when the slot is empty.
uintptr_t sckAcquireLatest(int *width, int *height, uint64_t *seq) {
    os_unfair_lock_lock(&g_slotLock);
    CVPixelBufferRef frame = g_latestFrame;
    if (frame != NULL) CVPixelBufferRetain(frame);
    *seq = g_frameSeq;
    os_unfair_lock_unlock(&g_slotLock);
    if (frame == NULL) return 0;
    *width = (int)CVPixelBufferGetWidth(frame);
    *height = (int)CVPixelBufferGetHeight(frame);
    return (uintptr_t)frame;
}

void sckReleaseFrame(uintptr_t frame) {
    if (frame != 0) CVPixelBufferRelease((CVPixelBufferRef)frame);
}

// sckCopyFrameRGBA converts a BGRA frame into dst (RGBA, dstStride bytes per
// row, at least width x height). One vectorised pass; the pixel buffer's own
// row padding is honoured.
int sckCopyFrameRGBA(uintptr_t frameRef, void *dst, int width, int height, int dstStride) {
    CVPixelBufferRef frame = (CVPixelBufferRef)frameRef;
    if (frame == NULL || dst == NULL) return 13;
    if (CVPixelBufferGetPixelFormatType(frame) != kCVPixelFormatType_32BGRA) return 13;
    if (CVPixelBufferLockBaseAddress(frame, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return 13;

    int rc = 0;
    void *base = CVPixelBufferGetBaseAddress(frame);
    size_t srcW = CVPixelBufferGetWidth(frame);
    size_t srcH = CVPixelBufferGetHeight(frame);
    if (base == NULL || srcW < (size_t)width || srcH < (size_t)height) {
        rc = 13;
    } else {
        vImage_Buffer src = { base, (vImagePixelCount)height, (vImagePixelCount)width, CVPixelBufferGetBytesPerRow(frame) };
        vImage_Buffer out = { dst, (vImagePixelCount)height, (vImagePixelCount)width, (size_t)dstStride };
        const uint8_t bgraToRgba[4] = { 2, 1, 0, 3 };
        if (vImagePermuteChannels_ARGB8888(&src, &out, bgraToRgba, kvImageNoFlags) != kvImageNoError) rc = 13;
    }
    CVPixelBufferUnlockBaseAddress(frame, kCVPixelBufferLock_ReadOnly);
    return rc;
}

// sckDisplayChanged reports whether the captured display went offline or
// changed pixel mode since the stream started. Display sleep is deliberately
// not a change (the display stays online in its mode); SCK reports a stream
// it cannot continue through stream:didStopWithError:.
int sckDisplayChanged(void) {
    if (g_displayID == 0 || g_stream == nil) return 0;
    if (!CGDisplayIsOnline(g_displayID)) return 1;
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(g_displayID);
    if (mode == NULL) return 0;
    size_t w = CGDisplayModeGetPixelWidth(mode);
    size_t h = CGDisplayModeGetPixelHeight(mode);
    CGDisplayModeRelease(mode);
    return (w != g_modePixelWidth || h != g_modePixelHeight) ? 1 : 0;
}

// initCapture queries the display list once and caches the filter and stream
// configuration for the target display. The stream itself starts on the first
// Capture(), so a stream that cannot produce frames is a capture-phase failure
// to the capability probe (#6105/#7046), not an init-phase one.
// Returns 0 on success, error code on failure.
int initCapture(int displayIndex) {
    sckStopStream();
    g_filter = nil;
    g_config = nil;
    g_displayID = 0;
    return sckBuildFilter(displayIndex, 0, 1);
}

// releaseCapture stops the stream and frees cached ScreenCaptureKit state.
void releaseCapture(void) {
    sckStopStream();
    g_filter = nil;
    g_config = nil;
    g_displayID = 0;
}

// screenCapturePreflight reports whether TCC says this process holds the
// Screen Recording grant (macOS 10.15+). Non-prompting.
int screenCapturePreflight(void) {
    return CGPreflightScreenCaptureAccess() ? 1 : 0;
}

// activeDisplayCount reports how many displays the window server currently
// has. One integer separates "nothing is attached" from "permission problem"
// (#4042) — the distinction that took four rounds to establish on #3380.
int activeDisplayCount(void) {
    return (int)[NSScreen screens].count;
}

// getScreenBounds returns the bounds of the specified display
void getScreenBounds(int displayIndex, int* width, int* height, int* error) {
    *error = 0;

    NSArray<NSScreen *>* screens = [NSScreen screens];
    if (screens.count == 0) {
        *error = 1;
        return;
    }

    NSUInteger idx = (NSUInteger)displayIndex;
    if (idx >= screens.count) {
        idx = 0;
    }

    NSScreen* screen = screens[idx];
    NSRect frame = [screen frame];
    CGFloat scaleFactor = [screen backingScaleFactor];

    *width = (int)(frame.size.width * scaleFactor);
    *height = (int)(frame.size.height * scaleFactor);
}
*/
import "C"

import (
	"fmt"
	"image"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// darwinCaptureMu serializes access to the global C statics (g_filter,
// g_config, the SCStream and its latest-frame slot).
// Only one darwinCapturer may be active at a time.
var darwinCaptureMu sync.Mutex

// macOSMajorVersion caches the Darwin kernel major version.
// Darwin 23 = macOS 14 (Sonoma), 22 = macOS 13, 21 = macOS 12.
var macOSMajorVersion = int(C.darwinMajorVersion())

// hasSCScreenshotManager returns true if running macOS 14+ (Darwin 23+), the
// floor for the ScreenCaptureKit capturer. The name predates #5928, which
// moved capture from per-frame SCScreenshotManager screenshots to a persistent
// SCStream; the version gate is unchanged.
func hasSCScreenshotManager() bool {
	return macOSMajorVersion >= 23
}

// darwinCapturer implements ScreenCapturer for macOS using ScreenCaptureKit (14+).
// The ScreenCaptureKit display list and filter are queried once at init time
// (triggering a single permission dialog); a persistent SCStream then delivers
// frames asynchronously into a latest-frame slot that Capture() copies (#5928).
type darwinCapturer struct {
	config          CaptureConfig
	mu              sync.Mutex
	initialized     bool
	holdsGlobalLock bool
	stream          *sckStreamController
}

// sckCaptureUnhealthy is the in-process fallback for the persisted
// ScreenCaptureKit verdict (capture_darwin_backend.go): it latches when a
// session found ScreenCaptureKit unable to capture while CoreGraphics could,
// and the verdict could not be written to disk. Once set, newPlatformCapturer
// routes this process's user-session captures to CoreGraphics until the
// helper restarts — the pre-#8058 behaviour (#6105).
var sckCaptureUnhealthy atomic.Bool

// sckProbeAttempts / sckProbeRetryDelay bound a capture session's
// ScreenCaptureKit attempts before it falls back to CoreGraphics: one retry,
// since each failed attempt can cost the stream-start timeout (5 s) plus
// sckFirstFrameTimeout. A refusal (-3801) is never retried.
const (
	sckProbeAttempts   = 2
	sckProbeRetryDelay = 500 * time.Millisecond
)

// Backend seams, swapped by tests so no test run on a developer's Mac ever
// opens a real ScreenCaptureKit stream (which could raise the consent dialog).
var (
	openSCKCapturer = newSCKCapturer
	openCGCapturer  = newCGCapturer
	// screenRecordingPreflight reports whether TCC says this process holds
	// the Screen Recording grant. Non-prompting.
	screenRecordingPreflight = func() bool { return C.screenCapturePreflight() != 0 }
)

func init() {
	platformCaptureProbePlan = darwinCaptureProbePlan
}

// darwinUserSessionBackends wires the real macOS 14+ backends for config.
func darwinUserSessionBackends(config CaptureConfig) macCaptureBackends {
	return macCaptureBackends{
		openSCK: func() (ScreenCapturer, error) {
			capturer, err := openSCKCapturer(config)
			if err != nil {
				// A zero display count means the fallback is doomed too and
				// the cause is a missing framebuffer, not a permission (#4042).
				slog.Warn("ScreenCaptureKit init failed",
					"error", err.Error(), "darwinVersion", macOSMajorVersion,
					"activeDisplayCount", int(C.activeDisplayCount()))
			}
			return capturer, err
		},
		openCG:    func() (ScreenCapturer, error) { return openCGCapturer(config) },
		preflight: screenRecordingPreflight,
	}
}

// darwinCaptureProbePlan orders a capability probe's backends.
//
// On macOS 14+ in the user session a probe never calls ScreenCaptureKit unless
// the caller explicitly allows it (the CLI's `probe --sck`), and then at most
// once. Probes are permission checks — the TCC check loop, the background
// re-probe, the connect-time capability probe, the helper's startup log — and
// on Sequoia every ScreenCaptureKit call can raise macOS's own consent dialog,
// whose approval does not persist for the bare helper binary (#8058). Only a
// real capture session (newPlatformCapturer) uses ScreenCaptureKit.
//
// A probe never records a verdict either: an explicit --sck probe runs in the
// operator's context, and macOS charges its capture to whatever launched it
// (Terminal, or breeze-agent), not to the launchd desktop helper.
func darwinCaptureProbePlan(config CaptureConfig, opts CaptureProbeOptions) captureProbePlan {
	if config.DesktopContext == "login_window" || !hasSCScreenshotManager() {
		return defaultCaptureProbePlan(config)
	}
	return macProbePlan(darwinUserSessionBackends(config), opts)
}

// newPlatformCapturer creates a new macOS screen capturer for a real capture
// session (remote desktop, screenshots).
//   - login window: CGDisplayStream.
//   - macOS 12-13: CoreGraphics (CGWindowListCreateImage).
//   - macOS 14+: ScreenCaptureKit (a persistent SCStream, #5928), verified by
//     taking its first frame here, retried once, and falling back to
//     CoreGraphics — unconditionally after an init failure, and after a
//     capture failure only when Screen Recording preflight reports the grant.
//     A capture-phase failure that CoreGraphics then covers is recorded as the
//     host's ScreenCaptureKit verdict, so later sessions — including in a
//     restarted helper — go straight to CoreGraphics instead of asking
//     ScreenCaptureKit (and, on Sequoia, the user) again (#6105, #8058).
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	if config.DesktopContext == "login_window" {
		return newDisplayStreamCapturer(config)
	}
	if !hasSCScreenshotManager() {
		return openCGCapturer(config)
	}
	return sckPolicy.openSessionCapturer(darwinUserSessionBackends(config), sckProbeAttempts, sckProbeRetryDelay)
}

// newSCKCapturer creates a ScreenCaptureKit-based capturer (macOS 14+).
func newSCKCapturer(config CaptureConfig) (ScreenCapturer, error) {
	darwinCaptureMu.Lock()
	errCode := int(C.initCapture(C.int(config.DisplayIndex)))
	if errCode != 0 {
		darwinCaptureMu.Unlock()
		return nil, translateDarwinError(errCode)
	}
	return &darwinCapturer{
		config:          config,
		initialized:     true,
		holdsGlobalLock: true,
		stream:          newSCKStreamController(sckStreamShim{displayIndex: config.DisplayIndex}),
	}, nil
}

// ---- ScreenCaptureKit capturer (macOS 14+) ----

// Capture returns the latest frame from the capturer's SCStream, or (nil, nil)
// when the screen has not changed since the last frame it returned — the same
// "no new frame" contract DXGI uses, which the session answers with a skip.
// The stream starts on the first call (#5928; see sckStreamController).
func (c *darwinCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.initialized {
		return nil, translateDarwinError(captureErrNotInitialized)
	}
	return c.stream.capture()
}

// CaptureLatest implements LatestFrameProvider: it always returns the current
// frame, changed or not, without consuming it from the stream loop.
func (c *darwinCapturer) CaptureLatest() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.initialized {
		return nil, translateDarwinError(captureErrNotInitialized)
	}
	return c.stream.latest()
}

// ForceReattach rebuilds the SCStream on the next capture, skipping any
// restart backoff. The session's no-video watchdog calls it.
func (c *darwinCapturer) ForceReattach() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.initialized {
		c.stream.forceRestart()
	}
}

// CaptureRegion captures a specific region of the screen
func (c *darwinCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	full, err := c.CaptureLatest()
	if err != nil {
		return nil, err
	}
	return cropRGBA(full, x, y, width, height), nil
}

// GetScreenBounds returns the screen dimensions
func (c *darwinCapturer) GetScreenBounds() (width, height int, err error) {
	return getScreenBoundsC(c.config.DisplayIndex)
}

// Close releases resources
func (c *darwinCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.initialized {
		c.stream.close()
		C.releaseCapture()
		c.initialized = false
	}
	if c.holdsGlobalLock {
		c.holdsGlobalLock = false
		darwinCaptureMu.Unlock()
	}
	return nil
}

// sckStreamShim is the cgo sckStreamBackend over the C statics above. It is
// only used while its capturer holds darwinCaptureMu.
type sckStreamShim struct {
	displayIndex int
}

func (s sckStreamShim) start(refreshFilter bool) error {
	refresh := C.int(0)
	if refreshFilter {
		refresh = 1
	}
	var nsCode C.long
	code := int(C.sckStartStream(C.int(s.displayIndex), refresh, &nsCode))
	if code == 0 {
		return nil
	}
	err := translateDarwinError(code)
	if nsCode != 0 {
		return fmt.Errorf("%w (SCStreamError %d)", err, int64(nsCode))
	}
	return err
}

func (s sckStreamShim) stop() { C.sckStopStream() }

func (s sckStreamShim) frameSeq() uint64 { return uint64(C.sckFrameSeq()) }

func (s sckStreamShim) copyLatest() (*image.RGBA, uint64, error) {
	var w, h C.int
	var seq C.uint64_t
	frame := C.sckAcquireLatest(&w, &h, &seq)
	if frame == 0 {
		return nil, 0, translateDarwinError(captureErrFrameUnavailable)
	}
	defer C.sckReleaseFrame(frame)
	width, height := int(w), int(h)
	if width <= 0 || height <= 0 {
		return nil, 0, translateDarwinError(captureErrFrameUnavailable)
	}
	img := captureImagePool.Get(width, height)
	if rc := int(C.sckCopyFrameRGBA(frame, unsafe.Pointer(&img.Pix[0]), w, h, C.int(img.Stride))); rc != 0 {
		captureImagePool.Put(img)
		return nil, 0, translateDarwinError(rc)
	}
	return img, uint64(seq), nil
}

func (s sckStreamShim) stopError() error {
	var code C.long
	if C.sckStreamStopState(&code) == 0 {
		return nil
	}
	return fmt.Errorf("ScreenCaptureKit stopped the stream (SCStreamError %d)", int64(code))
}

func (s sckStreamShim) displayChanged() bool { return C.sckDisplayChanged() != 0 }

// ---- Shared helpers ----

// captureRegionFromFull captures a region by first capturing the full screen
// and then cropping to the specified rectangle.
func captureRegionFromFull(c ScreenCapturer, x, y, width, height int) (*image.RGBA, error) {
	fullImg, err := c.Capture()
	if err != nil {
		return nil, err
	}
	if fullImg == nil {
		return nil, fmt.Errorf("no frame captured")
	}
	return cropRGBA(fullImg, x, y, width, height), nil
}

// cropRGBA copies the x,y,width,height rectangle of fullImg, clamped to its
// bounds.
func cropRGBA(fullImg *image.RGBA, x, y, width, height int) *image.RGBA {
	bounds := image.Rect(x, y, x+width, y+height)
	if !bounds.In(fullImg.Bounds()) {
		if x+width > fullImg.Bounds().Dx() {
			width = fullImg.Bounds().Dx() - x
		}
		if y+height > fullImg.Bounds().Dy() {
			height = fullImg.Bounds().Dy() - y
		}
	}

	cropped := image.NewRGBA(image.Rect(0, 0, width, height))
	for dy := 0; dy < height; dy++ {
		for dx := 0; dx < width; dx++ {
			cropped.Set(dx, dy, fullImg.At(x+dx, y+dy))
		}
	}

	return cropped
}

// getScreenBoundsC calls the C getScreenBounds function.
func getScreenBoundsC(displayIndex int) (int, int, error) {
	var cWidth, cHeight, cError C.int

	C.getScreenBounds(C.int(displayIndex), &cWidth, &cHeight, &cError)

	if cError != 0 {
		return 0, 0, translateDarwinError(int(cError))
	}

	return int(cWidth), int(cHeight), nil
}

// translateDarwinError forwards to the platform-neutral mapping in
// capture_errors.go. That file carries no build tag on purpose: this one is
// `darwin && cgo`, and the Test Agent CI job runs on ubuntu-latest, so a test
// living beside this function would compile out and never run (#4042).
func translateDarwinError(code int) error {
	return translateCaptureError(code)
}

var _ ScreenCapturer = (*darwinCapturer)(nil)
