#include "browser_gtk.h"

#include <gdk/gdkkeysyms.h>
#include <gtk/gtk.h>
#include <jsc/jsc.h>
#include <webkit2/webkit2.h>

enum {
  OP_INIT = 1,
  OP_MOUNT = 2,
  OP_BOUNDS = 3,
  OP_VISIBLE = 4,
  OP_NAVIGATE = 5,
  OP_BACK = 6,
  OP_FORWARD = 7,
  OP_RELOAD = 8,
  OP_STOP = 9,
  OP_ZOOM = 10,
  OP_INSPECT = 11,
  OP_FOCUS = 12,
  OP_CLOSE = 13,
  OP_BLUR = 14,
};

typedef struct {
  int op;
  int a, b, c, d;
  double zoom;
  char *s;
} AliceBrowserCall;

static GtkWidget *alice_browser_view = NULL;
static GtkWidget *alice_browser_overlay = NULL;
/* Wails' own WebView: focus returns here when our surface hides. */
static GtkWidget *alice_browser_shell_view = NULL;
static gint alice_browser_ready_flag = 0;
static gint alice_browser_devtools_flag = 0;

static GtkWidget *alice_find_webview(GtkWidget *widget) {
  if (!widget) {
    return NULL;
  }

  if (WEBKIT_IS_WEB_VIEW(widget)) {
    return widget;
  }

  if (!GTK_IS_CONTAINER(widget)) {
    return NULL;
  }

  GList *children = gtk_container_get_children(GTK_CONTAINER(widget));
  GtkWidget *found = NULL;

  for (GList *item = children; item; item = item->next) {
    found = alice_find_webview(GTK_WIDGET(item->data));

    if (found) {
      break;
    }
  }

  g_list_free(children);

  return found;
}

/* WebKitGTK 2.54 dropped the `console-message` signal (verified with
   g_signal_lookup). The supported replacement is a document-start user script
   that forwards console.error / window.onerror / unhandledrejection to a
   script message handler. Errors raised before the document starts are the only
   ones it cannot see. */
static const char *ALICE_CONSOLE_SHIM =
    "(function () {"
    "  if (window.__aliceConsoleHooked) { return; }"
    "  window.__aliceConsoleHooked = true;"
    "  function post(payload) {"
    "    try { window.webkit.messageHandlers.aliceConsole.postMessage(JSON.stringify(payload)); } catch (e) {}"
    "  }"
    "  var orig = console.error;"
    "  console.error = function () {"
    "    var parts = Array.prototype.map.call(arguments, function (a) {"
    "      if (typeof a === 'string') { return a; }"
    "      try { return JSON.stringify(a); } catch (e) { return String(a); }"
    "    });"
    "    post({ level: 'error', message: parts.join(' '), source: 'console', line: 0 });"
    "    return orig.apply(console, arguments);"
    "  };"
    "  window.addEventListener('error', function (e) {"
    "    post({ level: 'error', message: e.message || 'Script error', source: e.filename || '', line: e.lineno || 0 });"
    "  });"
    "  window.addEventListener('unhandledrejection', function (e) {"
    "    var r = e.reason;"
    "    post({ level: 'error', message: 'Unhandled rejection: ' + (r && r.message ? r.message : String(r)), source: 'promise', line: 0 });"
    "  });"
    "})();";

static void alice_on_console_message(WebKitUserContentManager *manager_, WebKitJavascriptResult *result, gpointer data) {
  (void)manager_;
  (void)data;
  JSCValue *value = webkit_javascript_result_get_js_value(result);

  if (!value) {
    return;
  }

  gchar *text = jsc_value_to_string(value);

  if (text) {
    aliceBrowserEvent("console-error", text);
    g_free(text);
  }
}

/*
 * Keyboard.
 *
 * The page owns the keyboard while it has focus, so app shortcuts have to be
 * picked up before WebKit handles them. A GtkEventControllerKey attached to the
 * toplevel in the capture phase runs ahead of the focus widget; the callbacks
 * forward the two shortcuts React must own and let everything else through.
 */
static gboolean alice_on_key_pressed(GtkEventControllerKey *controller, guint keyval, guint keycode,
                                     GdkModifierType state, gpointer data) {
  (void)controller;
  (void)keycode;

  GtkWindow *window = GTK_WINDOW(data);

  if (!alice_browser_view || !window) {
    return FALSE;
  }

  GtkWidget *focus = gtk_window_get_focus(window);
  gboolean ours = focus && (focus == alice_browser_view || gtk_widget_is_ancestor(focus, alice_browser_view));

  if (!ours) {
    return FALSE;
  }

  GdkModifierType mods = state & gtk_accelerator_get_default_mod_mask();

  if (keyval == GDK_KEY_Escape && mods == 0) {
    aliceBrowserEvent("shortcut", "escape");

    return FALSE;
  }

  if ((keyval == GDK_KEY_k || keyval == GDK_KEY_K) &&
      (mods == GDK_CONTROL_MASK || mods == GDK_SUPER_MASK)) {
    aliceBrowserEvent("shortcut", "palette");

    return TRUE;
  }

  return FALSE;
}

static GtkWidget *manager_webview_new(WebKitWebContext *context) {
  if (context) {
    return webkit_web_view_new_with_context(context);
  }

  return webkit_web_view_new();
}

static void alice_on_uri(GObject *object, GParamSpec *pspec, gpointer data) {
  (void)pspec;
  (void)data;
  const gchar *uri = webkit_web_view_get_uri(WEBKIT_WEB_VIEW(object));
  aliceBrowserEvent("url", (char *)(uri ? uri : ""));
}

static void alice_on_title(GObject *object, GParamSpec *pspec, gpointer data) {
  (void)pspec;
  (void)data;
  const gchar *title = webkit_web_view_get_title(WEBKIT_WEB_VIEW(object));
  aliceBrowserEvent("title", (char *)(title ? title : ""));
}

static void alice_on_load_changed(WebKitWebView *view, WebKitLoadEvent event, gpointer data) {
  (void)view;
  (void)data;

  if (event == WEBKIT_LOAD_STARTED) {
    aliceBrowserEvent("load", "started");
  } else if (event == WEBKIT_LOAD_FINISHED) {
    aliceBrowserEvent("load", "finished");
  }
}

static GtkWidget *alice_on_create(WebKitWebView *view, WebKitNavigationAction *action, gpointer data) {
  (void)view;
  (void)data;
  WebKitURIRequest *request = webkit_navigation_action_get_request(action);
  const gchar *uri = request ? webkit_uri_request_get_uri(request) : NULL;

  if (uri) {
    aliceBrowserEvent("new-window", (char *)uri);
  }

  /* Never let a page open an unmanaged popup; the UI decides what to do. */
  return NULL;
}

static void alice_apply_bounds(int x, int y, int width, int height) {
  if (!alice_browser_view) {
    return;
  }

  if (width < 1) {
    width = 1;
  }

  if (height < 1) {
    height = 1;
  }

  gtk_widget_set_margin_start(alice_browser_view, x < 0 ? 0 : x);
  gtk_widget_set_margin_top(alice_browser_view, y < 0 ? 0 : y);
  gtk_widget_set_size_request(alice_browser_view, width, height);
}

static int alice_ensure_browser(int devtools, const char *data_dir) {
  if (alice_browser_view) {
    return 1;
  }

  GList *toplevels = gtk_window_list_toplevels();
  GtkWidget *main_view = NULL;
  GtkWindow *window = NULL;

  for (GList *item = toplevels; item; item = item->next) {
    GtkWidget *candidate = GTK_WIDGET(item->data);

    if (!GTK_IS_WINDOW(candidate) || !gtk_widget_get_visible(candidate)) {
      continue;
    }

    GtkWidget *view = alice_find_webview(candidate);

    if (view) {
      main_view = view;
      window = GTK_WINDOW(candidate);
      break;
    }
  }

  g_list_free(toplevels);

  if (!main_view || !window) {
    return 0;
  }

  GtkWidget *view_box = gtk_widget_get_parent(main_view);
  GtkWidget *host = view_box ? gtk_widget_get_parent(view_box) : NULL;

  if (!host || !GTK_IS_BOX(host)) {
    return 0;
  }

  /* Wrap the shell's webview in an overlay so ours can float above it. */
  g_object_ref(view_box);
  gtk_container_remove(GTK_CONTAINER(host), view_box);

  GtkWidget *overlay = gtk_overlay_new();
  gtk_container_add(GTK_CONTAINER(overlay), view_box);
  g_object_unref(view_box);
  gtk_box_pack_start(GTK_BOX(host), overlay, TRUE, TRUE, 0);
  gtk_widget_show(overlay);

  /* A dedicated data manager keeps cookies/localStorage under the profile's
     ALICE_HOME instead of the process-wide default, so a session survives a
     restart. */
  WebKitWebsiteDataManager *manager = NULL;
  WebKitWebContext *context = NULL;

  if (data_dir && *data_dir) {
    gchar *cache_dir = g_build_filename(data_dir, "cache", NULL);
    g_mkdir_with_parents(data_dir, 0700);
    g_mkdir_with_parents(cache_dir, 0700);
    manager = webkit_website_data_manager_new(
        "base-data-directory", data_dir,
        "base-cache-directory", cache_dir,
        NULL);

    /* New data managers keep cookies in memory unless a persistent store is
       configured explicitly; localStorage persisted on its own, cookies did
       not. Point the cookie manager at the profile so logins survive. */
    WebKitCookieManager *cookies = webkit_website_data_manager_get_cookie_manager(manager);
    gchar *cookie_db = g_build_filename(data_dir, "cookies.sqlite", NULL);

    webkit_cookie_manager_set_persistent_storage(
        cookies, cookie_db, WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE);
    webkit_cookie_manager_set_accept_policy(
        cookies, WEBKIT_COOKIE_POLICY_ACCEPT_NO_THIRD_PARTY);

    g_free(cookie_db);
    g_free(cache_dir);
  }

  if (manager) {
    context = webkit_web_context_new_with_website_data_manager(manager);
    g_object_unref(manager);
  }

  GtkWidget *browser = manager_webview_new(context);

  if (context) {
    g_object_unref(context); /* the view keeps its own reference */
  }

  WebKitUserContentManager *ucm = webkit_web_view_get_user_content_manager(WEBKIT_WEB_VIEW(browser));

  if (ucm) {
    webkit_user_content_manager_register_script_message_handler(ucm, "aliceConsole");
    g_signal_connect(ucm, "script-message-received::aliceConsole",
                     G_CALLBACK(alice_on_console_message), NULL);
    WebKitUserScript *shim = webkit_user_script_new(
        ALICE_CONSOLE_SHIM, WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
        WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, NULL, NULL);
    webkit_user_content_manager_add_script(ucm, shim);
    webkit_user_script_unref(shim);
  }
  WebKitSettings *settings = webkit_web_view_get_settings(WEBKIT_WEB_VIEW(browser));
  alice_browser_devtools_flag = devtools ? 1 : 0;
  webkit_settings_set_enable_developer_extras(settings, devtools ? TRUE : FALSE);
  webkit_settings_set_enable_media_stream(settings, FALSE);
  webkit_settings_set_enable_webaudio(settings, FALSE);
  webkit_settings_set_enable_page_cache(settings, TRUE);

  GtkEventController *keys = gtk_event_controller_key_new(GTK_WIDGET(window));
  gtk_event_controller_set_propagation_phase(keys, GTK_PHASE_CAPTURE);
  g_signal_connect(keys, "key-pressed", G_CALLBACK(alice_on_key_pressed), window);

  g_signal_connect(browser, "notify::uri", G_CALLBACK(alice_on_uri), NULL);
  g_signal_connect(browser, "notify::title", G_CALLBACK(alice_on_title), NULL);
  g_signal_connect(browser, "load-changed", G_CALLBACK(alice_on_load_changed), NULL);
  g_signal_connect(browser, "create", G_CALLBACK(alice_on_create), NULL);

  gtk_widget_set_halign(browser, GTK_ALIGN_START);
  gtk_widget_set_valign(browser, GTK_ALIGN_START);
  gtk_widget_set_hexpand(browser, FALSE);
  gtk_widget_set_vexpand(browser, FALSE);
  gtk_widget_set_size_request(browser, 1, 1);
  gtk_widget_set_no_show_all(browser, TRUE);
  gtk_overlay_add_overlay(GTK_OVERLAY(overlay), browser);
  gtk_widget_hide(browser);

  alice_browser_view = browser;
  alice_browser_overlay = overlay;
  alice_browser_shell_view = main_view;
  g_atomic_int_set(&alice_browser_ready_flag, 1);

  return 1;
}

static gboolean alice_browser_dispatch(gpointer data) {
  AliceBrowserCall *call = (AliceBrowserCall *)data;

  switch (call->op) {
    case OP_INIT:
      alice_ensure_browser(call->a, call->s);
      break;
    case OP_MOUNT:
      if (alice_ensure_browser(call->a, call->s)) {
        alice_apply_bounds(call->a, call->b, call->c, call->d);
        gtk_widget_set_visible(alice_browser_view, TRUE);
      }
      break;
    case OP_BOUNDS:
      alice_apply_bounds(call->a, call->b, call->c, call->d);
      break;
    case OP_VISIBLE:
      if (alice_browser_view) {
        gboolean hide = call->a ? FALSE : TRUE;

        if (hide && alice_browser_shell_view) {
          /* A dialog/palette is about to own the keyboard. Unconditional: even
             if the page lost GTK focus already, the shell must be the focus
             widget so its DOM receives Escape/typing. No-op when it already
             is. */
          gtk_widget_grab_focus(alice_browser_shell_view);
        }

        gtk_widget_set_visible(alice_browser_view, call->a ? TRUE : FALSE);
      }
      break;
    case OP_NAVIGATE:
      if (alice_browser_view && call->s && *call->s) {
        webkit_web_view_load_uri(WEBKIT_WEB_VIEW(alice_browser_view), call->s);
      }
      break;
    case OP_BACK:
      if (alice_browser_view && webkit_web_view_can_go_back(WEBKIT_WEB_VIEW(alice_browser_view))) {
        webkit_web_view_go_back(WEBKIT_WEB_VIEW(alice_browser_view));
      }
      break;
    case OP_FORWARD:
      if (alice_browser_view && webkit_web_view_can_go_forward(WEBKIT_WEB_VIEW(alice_browser_view))) {
        webkit_web_view_go_forward(WEBKIT_WEB_VIEW(alice_browser_view));
      }
      break;
    case OP_RELOAD:
      if (alice_browser_view) {
        webkit_web_view_reload(WEBKIT_WEB_VIEW(alice_browser_view));
      }
      break;
    case OP_STOP:
      if (alice_browser_view) {
        webkit_web_view_stop_loading(WEBKIT_WEB_VIEW(alice_browser_view));
      }
      break;
    case OP_ZOOM:
      if (alice_browser_view) {
        webkit_web_view_set_zoom_level(WEBKIT_WEB_VIEW(alice_browser_view), call->zoom);
      }
      break;
    case OP_INSPECT:
      if (alice_browser_view && alice_browser_devtools_flag) {
        WebKitWebInspector *inspector = webkit_web_view_get_inspector(WEBKIT_WEB_VIEW(alice_browser_view));
        webkit_web_inspector_show(inspector);
      }
      break;
    case OP_FOCUS:
      if (alice_browser_view) {
        gtk_widget_grab_focus(alice_browser_view);
      }
      break;
    case OP_BLUR:
      if (alice_browser_shell_view) {
        gtk_widget_grab_focus(alice_browser_shell_view);
      }
      break;
    case OP_CLOSE:
      if (alice_browser_view) {
        webkit_web_view_stop_loading(WEBKIT_WEB_VIEW(alice_browser_view));
        webkit_web_view_load_uri(WEBKIT_WEB_VIEW(alice_browser_view), "about:blank");
        gtk_widget_set_visible(alice_browser_view, FALSE);
      }
      break;
    default:
      break;
  }

  g_free(call->s);
  g_free(call);

  return G_SOURCE_REMOVE;
}

static void alice_browser_post_call(AliceBrowserCall *call) {
  g_idle_add(alice_browser_dispatch, call);
}

void alice_browser_post(int op, int a, int b, int c, int d, const char *s) {
  AliceBrowserCall *call = g_new0(AliceBrowserCall, 1);
  call->op = op;
  call->a = a;
  call->b = b;
  call->c = c;
  call->d = d;
  call->s = s ? g_strdup(s) : NULL;
  alice_browser_post_call(call);
}

void alice_browser_post_zoom(double zoom) {
  AliceBrowserCall *call = g_new0(AliceBrowserCall, 1);
  call->op = OP_ZOOM;
  call->zoom = zoom;
  alice_browser_post_call(call);
}

int alice_browser_ready(void) {
  return g_atomic_int_get(&alice_browser_ready_flag);
}

