//go:build !linux || !cgo

package main

import (
	"log"
	"net/http"
)

func runWithTray(srv *http.Server, addr string) {
	log.Printf("listen %s", addr)
	log.Fatal(srv.ListenAndServe())
}
