package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type statsPayload struct {
	AdsBlockedStat     int64 `json:"adsBlockedStat"`
	BandwidthSavedStat int64 `json:"bandwidthSavedStat"`
}

type errPayload struct {
	Error string `json:"error"`
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return ""
}

func defaultPreferencesPaths() []string {
	h := homeDir()
	if h == "" {
		return nil
	}
	return []string{
		filepath.Join(h, ".config/BraveSoftware/Brave-Browser/Default/Preferences"),
		filepath.Join(h, ".config/BraveSoftware/Brave-Browser-Beta/Default/Preferences"),
		filepath.Join(h, "Library/Application Support/BraveSoftware/Brave-Browser/Default/Preferences"),
		filepath.Join(h, "AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Preferences"),
	}
}

func findPreferences() (string, bool) {
	if env := os.Getenv("BRAVE_PREFERENCES"); env != "" {
		p := filepath.Clean(os.ExpandEnv(env))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, true
		}
	}
	for _, p := range defaultPreferencesPaths() {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, true
		}
	}
	return "", false
}

func statInt64(v any) int64 {
	switch x := v.(type) {
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	case float64:
		return int64(x)
	default:
		return 0
	}
}

func readStats(prefsPath string) (statsPayload, error) {
	raw, err := os.ReadFile(prefsPath)
	if err != nil {
		return statsPayload{}, err
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return statsPayload{}, err
	}
	brave, _ := root["brave"].(map[string]any)
	stats, _ := brave["stats"].(map[string]any)
	out := statsPayload{
		AdsBlockedStat:     statInt64(stats["ads_blocked"]),
		BandwidthSavedStat: statInt64(stats["bandwidth_saved_bytes"]),
	}
	return out, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		http.Error(w, `{"error":"marshal"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func statsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p, ok := findPreferences()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, errPayload{Error: "Preferences not found"})
		return
	}
	st, err := readStats(p)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errPayload{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func browserPageRoot() string {
	if v := os.Getenv("BROWSER_PAGE_ROOT"); v != "" {
		return filepath.Clean(os.ExpandEnv(v))
	}
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	// …/BrowserPage/service/start-page → корень репозитория
	return filepath.Clean(filepath.Join(wd, "..", ".."))
}

type rootHandler struct {
	root          string
	statsPath     string
	bookmarksHTTP string
	bookmarksFile string
}

func (h *rootHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if p == h.bookmarksHTTP {
		switch r.Method {
		case http.MethodGet:
			bookmarksGetHandler(w, r, h.bookmarksFile)
		case http.MethodPut, http.MethodOptions:
			bookmarksPutHandler(w, r, h.bookmarksFile)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}
	if p == h.statsPath {
		statsHandler(w, r)
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if p == "/" || p == "/index.html" {
		raw, err := os.ReadFile(filepath.Join(h.root, "index.html"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		list, err := readBookmarksJSON(h.bookmarksFile)
		if err != nil {
			log.Printf("bookmarks read: %v", err)
			list = []bookmark{}
		}
		out, err := injectBookmarksIntoIndex(raw, list)
		if err != nil {
			log.Printf("bookmarks inject: %v", err)
			out = raw
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(out)
		return
	}

	rel := strings.TrimPrefix(filepath.Clean("/"+strings.TrimPrefix(p, "/")), "/")
	d := http.Dir(h.root)
	f, err := d.Open(rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, rel, fi.ModTime(), f)
}

func main() {
	host := os.Getenv("BRAVE_STATS_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("BRAVE_STATS_PORT")
	if port == "" {
		port = "7777"
	}
	addr := host + ":" + port
	root := browserPageRoot()

	if st, err := os.Stat(filepath.Join(root, "index.html")); err != nil || st.IsDir() {
		log.Printf("warning: index.html not found in BROWSER_PAGE_ROOT=%q (статика будет 404)", root)
	} else {
		log.Printf("static: %q", root)
	}

	statsPath := strings.TrimSpace(os.Getenv("BRAVE_STATS_HTTP_PATH"))
	if statsPath == "" {
		statsPath = "/api/brave-stats.json"
	} else if !strings.HasPrefix(statsPath, "/") {
		statsPath = "/" + statsPath
	}

	bookmarksHTTP := strings.TrimSpace(os.Getenv("BOOKMARKS_HTTP_PATH"))
	if bookmarksHTTP == "" {
		bookmarksHTTP = "/api/bookmarks.json"
	} else if !strings.HasPrefix(bookmarksHTTP, "/") {
		bookmarksHTTP = "/" + bookmarksHTTP
	}
	bmFile := bookmarksFilePath(root)
	log.Printf("bookmarks file: %q  API: %s", bmFile, bookmarksHTTP)

	h := &rootHandler{
		root:          root,
		statsPath:     statsPath,
		bookmarksHTTP: bookmarksHTTP,
		bookmarksFile: bmFile,
	}

	log.Printf("listen %s  GET / → index+закладки;  GET %s → brave-stats;  GET/PUT %s → закладки JSON", addr, statsPath, bookmarksHTTP)
	if err := http.ListenAndServe(addr, h); err != nil {
		log.Fatal(err)
	}
}
