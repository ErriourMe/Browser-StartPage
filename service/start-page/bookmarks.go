package main

import (
	"bytes"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

type bookmark struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

func bookmarksFilePath(root string) string {
	if v := strings.TrimSpace(os.Getenv("BOOKMARKS_FILE")); v != "" {
		p := filepath.Clean(os.ExpandEnv(v))
		if filepath.IsAbs(p) {
			return p
		}
		if root == "" {
			return filepath.Join(filepath.Dir(xdgBookmarksFile()), p)
		}
		return filepath.Join(root, p)
	}
	if root == "" {
		return xdgBookmarksFile()
	}
	repo := filepath.Join(root, "bookmarks.json")
	if bookmarksPathUsable(repo) {
		return repo
	}
	return xdgBookmarksFile()
}

func xdgBookmarksFile() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "bookmarks.json"
		}
		base = filepath.Join(h, ".local", "share")
	}
	return filepath.Join(base, "browser-startpage", "bookmarks.json")
}

func bookmarksPathUsable(path string) bool {
	f, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err == nil {
		_ = f.Close()
		return true
	}
	if os.IsNotExist(err) {
		return dirWritable(filepath.Dir(path))
	}
	return false
}

func dirWritable(dir string) bool {
	return os.MkdirAll(dir, 0o755) == nil &&
		os.WriteFile(filepath.Join(dir, ".write-test"), []byte{}, 0o644) == nil &&
		os.Remove(filepath.Join(dir, ".write-test")) == nil
}

func normalizeBookmarkURL(raw string) string {
	t := strings.TrimSpace(raw)
	if t == "" {
		return ""
	}
	if !strings.HasPrefix(strings.ToLower(t), "http://") && !strings.HasPrefix(strings.ToLower(t), "https://") {
		t = "https://" + t
	}
	return t
}

func letterFromTitle(title string) string {
	t := strings.TrimSpace(title)
	if t == "" {
		return "?"
	}
	r, _ := utf8.DecodeRuneInString(t)
	if r == utf8.RuneError || r == 0 {
		return "?"
	}
	return string(unicode.ToUpper(r))
}

func hostFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

func faviconServiceURL(host string) string {
	return "https://www.google.com/s2/favicons?sz=64&domain=" + url.QueryEscape(strings.ToLower(host))
}

func readBookmarksJSON(path string) ([]bookmark, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []bookmark{}, nil
		}
		return nil, err
	}
	var arr []bookmark
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, err
	}
	out := make([]bookmark, 0, len(arr))
	for _, b := range arr {
		if b.URL == "" {
			continue
		}
		u := normalizeBookmarkURL(b.URL)
		if u == "" {
			continue
		}
		t := strings.TrimSpace(b.Title)
		if t == "" {
			t = u
		}
		if len(t) > 32 {
			t = t[:32]
		}
		id := strings.TrimSpace(b.ID)
		if id == "" {
			continue
		}
		out = append(out, bookmark{ID: id, Title: t, URL: u})
	}
	return out, nil
}

func writeBookmarksJSON(path string, list []bookmark) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "bookmarks-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	return os.Chmod(path, 0o644)
}

func buildBookmarksSSR(list []bookmark) (htmlBlock string, err error) {
	j, err := json.Marshal(list)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	buf.WriteString(`<ul class="bookmarks" id="bookmarks">`)
	for _, b := range list {
		host := hostFromURL(b.URL)
		escTitle := html.EscapeString(b.Title)
		escURL := html.EscapeString(b.URL)
		escID := html.EscapeString(b.ID)
		fb := html.EscapeString(letterFromTitle(b.Title))
		imgSrc := ""
		if host != "" {
			imgSrc = html.EscapeString(faviconServiceURL(host))
		}
		buf.WriteString(`<li class="bookmark" data-bookmark-id="`)
		buf.WriteString(escID)
		buf.WriteString(`"><a class="bookmark-link has-icon" href="`)
		buf.WriteString(escURL)
		buf.WriteString(`" rel="noopener noreferrer" title="`)
		buf.WriteString(escTitle)
		buf.WriteString(`"`)
		if host != "" {
			buf.WriteString(` data-bookmark-host="`)
			buf.WriteString(html.EscapeString(host))
			buf.WriteString(`"`)
		}
		buf.WriteString(` draggable="false"><span class="bookmark-fallback" aria-hidden="true">`)
		buf.WriteString(fb)
		buf.WriteString(`</span><img class="bookmark-icon" alt="" decoding="sync" referrerpolicy="no-referrer" draggable="false"`)
		if imgSrc != "" {
			buf.WriteString(` src="`)
			buf.WriteString(imgSrc)
			buf.WriteString(`"`)
		}
		buf.WriteString(`></a><span class="bookmark-label">`)
		buf.WriteString(escTitle)
		buf.WriteString(`</span></li>`)
	}
	buf.WriteString(`</ul><script type="application/json" id="bookmarks-initial">`)
	buf.Write(j)
	buf.WriteString(`</script>`)
	return buf.String(), nil
}

func injectBookmarksIntoIndex(indexHTML []byte, list []bookmark) ([]byte, error) {
	block, err := buildBookmarksSSR(list)
	if err != nil {
		return nil, err
	}
	const marker = "<!--STARTPAGE_BOOKMARKS-->"
	if !bytes.Contains(indexHTML, []byte(marker)) {
		return nil, errNoBookmarkMarker
	}
	return bytes.ReplaceAll(indexHTML, []byte(marker), []byte(block)), nil
}

var errNoBookmarkMarker = errBookmarkMarker{}

type errBookmarkMarker struct{}

func (errBookmarkMarker) Error() string {
	return "index.html: missing <!--STARTPAGE_BOOKMARKS--> marker"
}

func bookmarksGetHandler(w http.ResponseWriter, r *http.Request, path string) {
	if r.Method == http.MethodOptions {
		writeBookmarksCORS(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	list, err := readBookmarksJSON(path)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errPayload{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func writeBookmarksCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func bookmarksPutHandler(w http.ResponseWriter, r *http.Request, path string) {
	if r.Method == http.MethodOptions {
		writeBookmarksCORS(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	var raw []map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		writeJSON(w, http.StatusBadRequest, errPayload{Error: "invalid JSON: " + err.Error()})
		return
	}
	list := make([]bookmark, 0, len(raw))
	for _, x := range raw {
		id, _ := x["id"].(string)
		title, _ := x["title"].(string)
		urlStr, _ := x["url"].(string)
		if id == "" || urlStr == "" {
			continue
		}
		u := normalizeBookmarkURL(urlStr)
		if u == "" {
			continue
		}
		t := strings.TrimSpace(title)
		if t == "" {
			t = u
		}
		if len(t) > 32 {
			t = t[:32]
		}
		list = append(list, bookmark{ID: id, Title: t, URL: u})
	}
	if err := writeBookmarksJSON(path, list); err != nil {
		writeJSON(w, http.StatusInternalServerError, errPayload{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
