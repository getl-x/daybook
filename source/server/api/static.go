package api

import (
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// assetPattern 判断"看起来像静态资源"的路径（带常见扩展名）。
// 与 Node 版 static.ts 的正则一致。
var assetPattern = regexp.MustCompile(
	`(?i)\.(?:js|mjs|cjs|css|map|json|webmanifest|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|txt|xml|wasm)$`,
)

// RegisterStatic 托管前端产物并做 SPA 回退。
//
// 返回 false 表示没有产物——本地开发时就是这个状态（前端跑 Vite dev server，
// 由它代理 /v1），此时只提供 API。
func RegisterStatic(event *core.ServeEvent, publicDir string) bool {
	if _, err := os.Stat(filepath.Join(publicDir, "index.html")); err != nil {
		return false
	}

	// 通配路由在 API 路由之后注册：Echo 先匹配已注册的精确路由，
	// 所以 /v1/… 与 /_/ 不会被这里吃掉。
	event.Router.GET("/{path...}", func(request *core.RequestEvent) error {
		// path.Clean 会消掉 ../，配合 os.DirFS/os.ReadFile 的路径拼接，
		// 请求方无法用 "..%2f" 之类的手段跑出产物目录。
		cleaned := path.Clean("/" + strings.TrimPrefix(request.Request.PathValue("path"), "/"))
		name := strings.TrimPrefix(cleaned, "/")

		if name == "" {
			return serveIndex(request, publicDir)
		}
		if data, err := os.ReadFile(filepath.Join(publicDir, filepath.FromSlash(name))); err == nil {
			return writeFile(request, name, data)
		}

		// 找不到文件。这里必须把三类路径分开处理——其中两条是 Node 版
		// 踩过坑之后特意加上的防护，理由写在各自的分支里。
		if isAPIPath(cleaned) || assetPattern.MatchString(cleaned) {
			return fail(request, http.StatusNotFound, "not_found")
		}
		if request.Request.Method != http.MethodGet {
			return fail(request, http.StatusNotFound, "not_found")
		}
		// 其余 GET 当作前端路由（/calendar、/day/2026-09-13 …）交给 SPA。
		return serveIndex(request, publicDir)
	})

	return true
}

// isAPIPath 判断是不是 API 路径。
//
// 为什么要单独判：API 找不到时返回 index.html 会让前端把 HTML 当 JSON 解析，
// 报出一个和真实原因毫无关系的解析错误。
func isAPIPath(cleaned string) bool {
	if cleaned == "/healthz" {
		return true
	}
	return cleaned == "/v1" || strings.HasPrefix(cleaned, "/v1/")
}

// applyCachePolicy 沿用 Node 版的缓存策略。
//
// 关键是 sw.js 与 index.html：Service Worker 一旦被长缓存，新版本就再也发不出去
// （用户浏览器一直拿着旧的 sw.js 和旧的资源清单）；index.html 引用的资源文件名
// 带哈希，它自己被缓存住的话用户会一直加载上一次的产物清单。
//
// 这里比 Node 版多一条：Node 版对直接请求 /index.html 也是 1 小时缓存，
// 只有 SPA 回退那条路径才设 no-cache。同一个文件两种缓存策略是隐患，
// 所以这里统一按 no-cache 处理。
func applyCachePolicy(header http.Header, name string) {
	base := path.Base(name)
	switch {
	case strings.HasPrefix(name, "assets/"):
		// vite 产物文件名带内容哈希，内容变了文件名就变 → 可以永久缓存
		header.Set("Cache-Control", "public, max-age=31536000, immutable")
	case base == "sw.js" || base == "index.html":
		header.Set("Cache-Control", "no-cache")
	default:
		header.Set("Cache-Control", "public, max-age=3600")
	}
}

func writeFile(request *core.RequestEvent, name string, data []byte) error {
	header := request.Response.Header()
	contentType := mime.TypeByExtension(path.Ext(name))
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	header.Set("Content-Type", contentType)
	applyCachePolicy(header, name)
	request.Response.WriteHeader(http.StatusOK)
	_, err := request.Response.Write(data)
	return err
}

// serveIndex 返回 index.html。
//
// 刻意用 no-cache：它引用的资源文件名带哈希，发版后如果 index.html 被缓存住，
// 用户会一直加载上一次的产物清单。
func serveIndex(request *core.RequestEvent, publicDir string) error {
	data, err := os.ReadFile(filepath.Join(publicDir, "index.html"))
	if err != nil {
		return fail(request, http.StatusNotFound, "not_found")
	}
	header := request.Response.Header()
	header.Set("Content-Type", "text/html; charset=utf-8")
	header.Set("Cache-Control", "no-cache")
	request.Response.WriteHeader(http.StatusOK)
	_, err = request.Response.Write(data)
	return err
}
