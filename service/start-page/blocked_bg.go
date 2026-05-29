package main

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const blockedBgImageExt = ".jpg"

func blockedBgFilePath(root string) string {
	if v := strings.TrimSpace(os.Getenv("BG_BLOCKED_FILE")); v != "" {
		p := filepath.Clean(os.ExpandEnv(v))
		if filepath.IsAbs(p) {
			return p
		}
		if root == "" {
			return filepath.Join(filepath.Dir(xdgBlockedBgFile()), p)
		}
		return filepath.Join(root, p)
	}
	if root == "" {
		return xdgBlockedBgFile()
	}
	repo := filepath.Join(root, "bg-blocked.json")
	if bookmarksPathUsable(repo) {
		return repo
	}
	return xdgBlockedBgFile()
}

func xdgBlockedBgFile() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return "bg-blocked.json"
		}
		base = filepath.Join(h, ".local", "share")
	}
	return filepath.Join(base, "browser-startpage", "bg-blocked.json")
}

func blockedBgImagesDir(jsonPath string) string {
	return filepath.Join(filepath.Dir(jsonPath), "bg-blocked-images")
}

func blockedBgImageHTTPPath() string {
	p := strings.TrimSpace(os.Getenv("BG_BLOCKED_IMAGE_HTTP_PATH"))
	if p == "" {
		return "/api/bg-blocked/image/"
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if !strings.HasSuffix(p, "/") {
		p += "/"
	}
	return p
}

func validBlockedBgID(id string) bool {
	if len(id) < 8 || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
			continue
		}
		return false
	}
	return true
}

func blockedImageFilePath(imagesDir, id string) string {
	return filepath.Join(imagesDir, id+blockedBgImageExt)
}

func writeBlockedImageFile(imagesDir, id string, body []byte, contentType string) error {
	_ = contentType
	if err := os.MkdirAll(imagesDir, 0o755); err != nil {
		return err
	}
	path := blockedImageFilePath(imagesDir, id)
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "bg-img-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	deleteBlockedImageFile(imagesDir, id)
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return os.Chmod(path, 0o644)
}

func deleteBlockedImageFile(imagesDir, id string) {
	for _, ext := range []string{".jpg", ".jpeg", ".png", ".webp", ".jfif"} {
		_ = os.Remove(filepath.Join(imagesDir, id+ext))
	}
}

func findBlockedImageFile(imagesDir, id string) (string, bool) {
	for _, ext := range []string{".jpg", ".jpeg", ".png", ".webp", ".jfif"} {
		p := filepath.Join(imagesDir, id+ext)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, true
		}
	}
	matches, err := filepath.Glob(filepath.Join(imagesDir, id+".*"))
	if err == nil {
		for _, p := range matches {
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				return p, true
			}
		}
	}
	return "", false
}

func pruneBlockedImages(imagesDir string, keepIDs []string) {
	entries, err := os.ReadDir(imagesDir)
	if err != nil {
		return
	}
	keep := make(map[string]struct{}, len(keepIDs))
	for _, id := range keepIDs {
		keep[id] = struct{}{}
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		id := strings.TrimSuffix(name, filepath.Ext(name))
		if _, ok := keep[id]; !ok {
			_ = os.Remove(filepath.Join(imagesDir, name))
		}
	}
}

type blockedBgData struct {
	IDs    []string `json:"ids"`
	Hashes []string `json:"hashes"`
}

func normalizeBlockedIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || !validBlockedBgID(id) {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func normalizeBlockedHashes(hashes []string) []string {
	out := make([]string, 0, len(hashes))
	seen := make(map[string]struct{}, len(hashes))
	for _, h := range hashes {
		h = strings.TrimSpace(strings.ToLower(h))
		if len(h) != 64 {
			continue
		}
		valid := true
		for _, c := range h {
			if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
				continue
			}
			valid = false
			break
		}
		if !valid {
			continue
		}
		if _, ok := seen[h]; ok {
			continue
		}
		seen[h] = struct{}{}
		out = append(out, h)
	}
	return out
}

func readBlockedBgData(path string) (blockedBgData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return blockedBgData{IDs: []string{}, Hashes: []string{}}, nil
		}
		return blockedBgData{}, err
	}
	var arr []string
	if err := json.Unmarshal(raw, &arr); err == nil {
		return blockedBgData{IDs: normalizeBlockedIDs(arr), Hashes: []string{}}, nil
	}
	var data blockedBgData
	if err := json.Unmarshal(raw, &data); err != nil {
		return blockedBgData{}, err
	}
	return blockedBgData{
		IDs:    normalizeBlockedIDs(data.IDs),
		Hashes: normalizeBlockedHashes(data.Hashes),
	}, nil
}

func writeBlockedBgData(path string, data blockedBgData) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	out := blockedBgData{
		IDs:    normalizeBlockedIDs(data.IDs),
		Hashes: normalizeBlockedHashes(data.Hashes),
	}
	payload, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "bg-blocked-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(payload); err != nil {
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

func blockedBgGetHandler(w http.ResponseWriter, r *http.Request, path string) {
	if r.Method == http.MethodOptions {
		writeBookmarksCORS(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	data, err := readBlockedBgData(path)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errPayload{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func blockedBgPutHandler(w http.ResponseWriter, r *http.Request, path string) {
	if r.Method == http.MethodOptions {
		writeBookmarksCORS(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	var data blockedBgData
	if err := json.Unmarshal(body, &data); err != nil {
		var raw []string
		if err2 := json.Unmarshal(body, &raw); err2 != nil {
			writeJSON(w, http.StatusBadRequest, errPayload{Error: "invalid JSON: " + err.Error()})
			return
		}
		data = blockedBgData{IDs: raw, Hashes: []string{}}
	}
	data.IDs = normalizeBlockedIDs(data.IDs)
	data.Hashes = normalizeBlockedHashes(data.Hashes)
	if err := writeBlockedBgData(path, data); err != nil {
		writeJSON(w, http.StatusInternalServerError, errPayload{Error: err.Error()})
		return
	}
	pruneBlockedImages(blockedBgImagesDir(path), data.IDs)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func blockedBgImageHandler(w http.ResponseWriter, r *http.Request, jsonPath, id string) {
	id = strings.TrimSpace(id)
	if !validBlockedBgID(id) {
		http.NotFound(w, r)
		return
	}
	imagesDir := blockedBgImagesDir(jsonPath)

	switch r.Method {
	case http.MethodOptions:
		writeBlockedBgCORS(w)
		w.WriteHeader(http.StatusNoContent)
	case http.MethodGet, http.MethodHead:
		imgPath, ok := findBlockedImageFile(imagesDir, id)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if ct := mime.TypeByExtension(filepath.Ext(imgPath)); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.Header().Set("Cache-Control", "no-cache")
		if r.Method == http.MethodHead {
			if st, err := os.Stat(imgPath); err == nil {
				w.Header().Set("Content-Length", strconv.Itoa(int(st.Size())))
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		http.ServeFile(w, r, imgPath)
	case http.MethodPut:
		writeBlockedBgCORS(w)
		body, err := io.ReadAll(io.LimitReader(r.Body, 12<<20))
		if err != nil {
			http.Error(w, "read body", http.StatusBadRequest)
			return
		}
		if len(body) == 0 {
			http.Error(w, "empty body", http.StatusBadRequest)
			return
		}
		ct := r.Header.Get("Content-Type")
		if err := writeBlockedImageFile(imagesDir, id, body, ct); err != nil {
			writeJSON(w, http.StatusInternalServerError, errPayload{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case http.MethodDelete:
		writeBlockedBgCORS(w)
		deleteBlockedImageFile(imagesDir, id)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
