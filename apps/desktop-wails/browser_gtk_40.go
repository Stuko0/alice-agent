//go:build linux && cgo && !webkit2_41

package main

/*
#cgo pkg-config: gtk+-3.0 webkit2gtk-4.0
#include <stdlib.h>
#include "browser_gtk.h"
*/
import "C"

import "unsafe"

func gtkBrowserPost(op, a, b, c, d int, s string) {
	var ptr *C.char

	if s != "" {
		ptr = C.CString(s)
		defer C.free(unsafe.Pointer(ptr))
	}

	C.alice_browser_post(C.int(op), C.int(a), C.int(b), C.int(c), C.int(d), ptr)
}

func gtkBrowserPostZoom(zoom float64) {
	C.alice_browser_post_zoom(C.double(zoom))
}

func gtkBrowserReady() bool {
	return C.alice_browser_ready() == 1
}

//export aliceBrowserEvent
func aliceBrowserEvent(kind, value *C.char) {
	browserDispatchEvent(C.GoString(kind), C.GoString(value))
}
