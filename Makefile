.PHONY: build run dev extension fix-bookmarks

BINARY := browser-startpage

build:
	mkdir -p service/start-page/web/css service/start-page/web/js service/start-page/web/fonts
	cp index.html service/start-page/web/index.html
	cp favicon.svg service/start-page/web/favicon.svg
	cp css/main.css service/start-page/web/css/main.css
	cp js/app.js service/start-page/web/js/app.js
	cp js/clock-boot.js service/start-page/web/js/clock-boot.js
	cp fonts/inter-latin.woff2 service/start-page/web/fonts/inter-latin.woff2
	cd service/start-page && CGO_ENABLED=1 CGO_CFLAGS="-Wno-deprecated-declarations" \
		go build -trimpath -ldflags="-s -w" -o ../../$(BINARY) .

run: build
	BROWSER_PAGE_ROOT="$(CURDIR)" ./$(BINARY)

dev:
	docker compose up --build -d

extension:
	mkdir -p extension/css extension/js extension/fonts
	sed 's|<!--STARTPAGE_BOOKMARKS-->|<ul class="bookmarks" id="bookmarks"></ul>|' index.html | \
		sed 's|</head>|  <script src="focus-bootstrap.js"></script>\n</head>|' \
		> extension/index.html
	cp favicon.svg extension/
	cp css/main.css extension/css/
	cp js/app.js extension/js/
	cp js/clock-boot.js extension/js/
	cp fonts/inter-latin.woff2 extension/fonts/

fix-bookmarks:
	@if [ -f bookmarks.json ] && [ ! -r bookmarks.json ]; then \
		sudo chown "$$(id -u):$$(id -g)" bookmarks.json; \
		chmod 644 bookmarks.json; \
		echo "bookmarks.json: права исправлены"; \
	else \
		echo "bookmarks.json: читать можно, ничего не делаем"; \
	fi
