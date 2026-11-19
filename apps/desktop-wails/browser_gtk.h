#ifndef ALICE_BROWSER_GTK_H
#define ALICE_BROWSER_GTK_H

/* Implemented in Go (//export aliceBrowserEvent). */
extern void aliceBrowserEvent(char *kind, char *value);

/* All three marshal onto the GTK main loop; safe to call from any goroutine. */
void alice_browser_post(int op, int a, int b, int c, int d, const char *s);
void alice_browser_post_zoom(double zoom);
int alice_browser_ready(void);

#endif /* ALICE_BROWSER_GTK_H */
