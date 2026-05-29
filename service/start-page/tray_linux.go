//go:build linux && cgo

package main

import (
	"context"
	_ "embed"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/getlantern/systray"
)

//go:embed trayicon.png
var trayIcon []byte

func runWithTray(srv *http.Server, addr string) {
	if os.Getenv("BROWSER_PAGE_NO_TRAY") != "" {
		runHeadless(srv, addr)
		return
	}

	go func() {
		log.Printf("listen %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	pageURL := "http://" + addr
	systray.Run(func() {
		systray.SetIcon(trayIcon)
		systray.SetTitle("Browser Start Page")
		systray.SetTooltip(pageURL)
		quit := systray.AddMenuItem("Выход", "Остановить сервер")
		go func() {
			<-quit.ClickedCh
			systray.Quit()
		}()
	}, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	})
}

func runHeadless(srv *http.Server, addr string) {
	log.Printf("listen %s (без трея)", addr)
	log.Fatal(srv.ListenAndServe())
}
