// R1 SDK host API: message helpers (headers/url/query/cookies/body) exposed
// to plugins as the `pulse` object. Functions operate directly on the goja
// objects that wrap the live message draft — there is no second copy of the
// message, so helpers and direct field writes see the same data.
package plugins

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/dop251/goja"
)

// sdk builds the R1 `pulse` API surface onto the given pulse object.
func sdk(vm *goja.Runtime, pulseObj *goja.Object) {
	buildHeadersAPI(vm, pulseObj)
	buildURLQueryAPI(vm, pulseObj)
	buildCookiesAPI(vm, pulseObj)
	buildBodyAPI(vm, pulseObj)
	buildEncodingCryptoAPI(vm, pulseObj)
}

// ---- headers ----

func buildHeadersAPI(vm *goja.Runtime, pulseObj *goja.Object) {
	h := vm.NewObject()
	_ = h.Set("get", func(call goja.FunctionCall) goja.Value {
		msg, name := headerArgs(vm, call)
		if msg == nil {
			return goja.Null()
		}
		for _, hdr := range headersOf(msg) {
			if strings.EqualFold(hdr.Get("name").String(), name) {
				return hdr.Get("value")
			}
		}
		return goja.Null()
	})
	_ = h.Set("getAll", func(call goja.FunctionCall) goja.Value {
		msg, name := headerArgs(vm, call)
		if msg == nil {
			return vm.ToValue([]string{})
		}
		var out []string
		for _, hdr := range headersOf(msg) {
			if strings.EqualFold(hdr.Get("name").String(), name) {
				out = append(out, hdr.Get("value").String())
			}
		}
		if out == nil {
			out = []string{}
		}
		return vm.ToValue(out)
	})
	_ = h.Set("set", func(call goja.FunctionCall) goja.Value {
		msg, name := headerArgs(vm, call)
		if msg == nil {
			return goja.Undefined()
		}
		value := argString(call, 2)
		headers := headersOf(msg)
		written := false
		var kept []*goja.Object
		for _, hdr := range headers {
			if strings.EqualFold(hdr.Get("name").String(), name) {
				if !written {
					hdr.Set("value", value)
					written = true
					kept = append(kept, hdr)
				}
				continue // remaining duplicates removed
			}
			kept = append(kept, hdr)
		}
		if !written {
			kept = append(kept, newHeader(vm, name, value))
		}
		msg.Set("headers", vm.ToValue(kept))
		return goja.Undefined()
	})
	_ = h.Set("append", func(call goja.FunctionCall) goja.Value {
		msg, name := headerArgs(vm, call)
		if msg == nil {
			return goja.Undefined()
		}
		headers := append(headersOf(msg), newHeader(vm, name, argString(call, 2)))
		msg.Set("headers", vm.ToValue(headers))
		return goja.Undefined()
	})
	_ = h.Set("remove", func(call goja.FunctionCall) goja.Value {
		msg, name := headerArgs(vm, call)
		if msg == nil {
			return vm.ToValue(0)
		}
		n := 0
		var kept []*goja.Object
		for _, hdr := range headersOf(msg) {
			if strings.EqualFold(hdr.Get("name").String(), name) {
				n++
				continue
			}
			kept = append(kept, hdr)
		}
		msg.Set("headers", vm.ToValue(kept))
		return vm.ToValue(n)
	})
	pulseObj.Set("headers", h)
}

func headerArgs(vm *goja.Runtime, call goja.FunctionCall) (*goja.Object, string) {
	if len(call.Arguments) < 2 {
		return nil, ""
	}
	msg, ok := call.Argument(0).(*goja.Object)
	if !ok {
		return nil, ""
	}
	return msg, call.Argument(1).String()
}

func headersOf(msg *goja.Object) []*goja.Object {
	v := msg.Get("headers")
	if v == nil {
		return nil
	}
	arr, ok := v.(*goja.Object)
	if !ok || arr.ClassName() != "Array" {
		return nil
	}
	var out []*goja.Object
	n := arr.Get("length")
	if n == nil {
		return nil
	}
	for i := 0; i < int(n.ToInteger()); i++ {
		if o, ok := arr.Get(fmt.Sprintf("%d", i)).(*goja.Object); ok {
			out = append(out, o)
		}
	}
	return out
}

func newHeader(vm *goja.Runtime, name, value string) *goja.Object {
	o := vm.NewObject()
	_ = o.Set("name", name)
	_ = o.Set("value", value)
	return o
}

// ---- url + query ----

func buildURLQueryAPI(vm *goja.Runtime, pulseObj *goja.Object) {
	u := vm.NewObject()
	_ = u.Set("parse", func(call goja.FunctionCall) goja.Value {
		raw := argString(call, 0)
		parsed, err := url.Parse(raw)
		if err != nil {
			return makeErr(vm, fmt.Sprintf("pulse.url.parse: %v", err))
		}
		q := vm.NewObject()
		_ = q.Set("scheme", parsed.Scheme)
		_ = q.Set("host", parsed.Hostname())
		_ = q.Set("port", parsed.Port())
		_ = q.Set("path", parsed.EscapedPath())
		_ = q.Set("query", parsed.RawQuery)
		return q
	})
	pulseObj.Set("url", u)

	qapi := vm.NewObject()
	_ = qapi.Set("getAll", func(call goja.FunctionCall) goja.Value {
		req, ok := call.Argument(0).(*goja.Object)
		name := argString(call, 1)
		var out []string
		if ok {
			if raw, has := objString(req, "url"); has {
				if parsed, err := url.Parse(raw); err == nil {
					out = parsed.Query()[name]
				}
			}
		}
		if out == nil {
			out = []string{}
		}
		return vm.ToValue(out)
	})
	// setURL updates the request's url in place: query params are encoded
	// with standard percent-encoding; + stays a literal plus (not space)
	_ = qapi.Set("set", func(call goja.FunctionCall) goja.Value {
		return mutateQuery(vm, call, func(vals []string, add []string, remove bool) []string {
			if remove {
				return nil
			}
			return add
		})
	})
	_ = qapi.Set("append", func(call goja.FunctionCall) goja.Value {
		return mutateQuery(vm, call, func(vals []string, add []string, _ bool) []string {
			return append(vals, add...)
		})
	})
	_ = qapi.Set("remove", func(call goja.FunctionCall) goja.Value {
		return mutateQuery(vm, call, func(_ []string, _ []string, _ bool) []string {
			return nil
		})
	})
	pulseObj.Set("query", qapi)
}

// mutateQuery applies fn(existing-values, new-values, remove) and rewrites
// the request URL. Argument 0 = request object, 1 = name, 2 = value (absent
// for remove).
func mutateQuery(vm *goja.Runtime, call goja.FunctionCall, fn func([]string, []string, bool) []string) goja.Value {
	req, ok := call.Argument(0).(*goja.Object)
	if !ok {
		return goja.Undefined()
	}
	name := argString(call, 1)
	var add []string
	if len(call.Arguments) > 2 && call.Argument(2) != goja.Undefined() && call.Argument(2) != goja.Null() {
		add = []string{call.Argument(2).String()}
	}
	raw, has := objString(req, "url")
	if !has {
		return goja.Undefined()
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return makeErr(vm, fmt.Sprintf("pulse.query: %v", err))
	}
	q := parsed.Query()
	q[name] = fn(q[name], add, len(add) == 0 && call.Argument(1) != goja.Undefined())
	parsed.RawQuery = encodeQuery(q)
	req.Set("url", parsed.String())
	return goja.Undefined()
}

// encodeQuery preserves repeat params and empty values; Query().Encode()
// would already satisfy both, but we go through it for the standard rules.
func encodeQuery(q url.Values) string { return q.Encode() }

// ---- cookies ----

func buildCookiesAPI(vm *goja.Runtime, pulseObj *goja.Object) {
	c := vm.NewObject()
	_ = c.Set("get", func(call goja.FunctionCall) goja.Value {
		msg, ok := call.Argument(0).(*goja.Object)
		name := argString(call, 1)
		if !ok {
			return goja.Null()
		}
		for _, pair := range cookiePairs(msg) {
			if pair[0] == name {
				return vm.ToValue(pair[1])
			}
		}
		return goja.Null()
	})
	_ = c.Set("set", func(call goja.FunctionCall) goja.Value {
		msg, ok := call.Argument(0).(*goja.Object)
		if !ok {
			return goja.Undefined()
		}
		name := argString(call, 1)
		value := argString(call, 2)
		var kept []string
		for _, pair := range cookiePairs(msg) {
			if pair[0] != name {
				kept = append(kept, pair[0]+"="+pair[1])
			}
		}
		kept = append(kept, name+"="+value)
		setCookieHeader(vm, msg, strings.Join(kept, "; "))
		return goja.Undefined()
	})
	_ = c.Set("remove", func(call goja.FunctionCall) goja.Value {
		msg, ok := call.Argument(0).(*goja.Object)
		if !ok {
			return goja.Undefined()
		}
		name := argString(call, 1)
		var kept []string
		for _, pair := range cookiePairs(msg) {
			if pair[0] != name {
				kept = append(kept, pair[0]+"="+pair[1])
			}
		}
		setCookieHeader(vm, msg, strings.Join(kept, "; "))
		return goja.Undefined()
	})
	pulseObj.Set("cookies", c)
}

// cookiePairs reads the Cookie header (request side) — response Set-Cookie
// handling belongs to the headers API (repeat Set-Cookie headers).
func cookiePairs(msg *goja.Object) [][2]string {
	var raw string
	for _, hdr := range headersOf(msg) {
		if strings.EqualFold(hdr.Get("name").String(), "Cookie") {
			raw = hdr.Get("value").String()
			break
		}
	}
	if raw == "" {
		return nil
	}
	var out [][2]string
	for _, part := range strings.Split(raw, ";") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		if k != "" {
			out = append(out, [2]string{k, v})
		}
	}
	return out
}

func setCookieHeader(vm *goja.Runtime, msg *goja.Object, value string) {
	for _, hdr := range headersOf(msg) {
		if strings.EqualFold(hdr.Get("name").String(), "Cookie") {
			hdr.Set("value", value)
			return
		}
	}
	headers := append(headersOf(msg), newHeader(vm, "Cookie", value))
	msg.Set("headers", vm.ToValue(headers))
}

// ---- body ----

func buildBodyAPI(vm *goja.Runtime, pulseObj *goja.Object) {
	b := vm.NewObject()
	_ = b.Set("json", func(call goja.FunctionCall) goja.Value {
		msg, ok := call.Argument(0).(*goja.Object)
		if !ok {
			return goja.Null()
		}
		body, _ := objString(msg, "body")
		var parsed any
		if err := json.Unmarshal([]byte(body), &parsed); err != nil {
			return makeErr(vm, "pulse.body.json: not valid JSON: "+err.Error())
		}
		return vm.ToValue(parsed)
	})
	_ = b.Set("setJSON", func(call goja.FunctionCall) goja.Value {
		msg, ok := call.Argument(0).(*goja.Object)
		if !ok {
			return goja.Undefined()
		}
		out, err := json.Marshal(call.Argument(1).Export())
		if err != nil {
			return makeErr(vm, "pulse.body.setJSON: "+err.Error())
		}
		msg.Set("body", string(out))
		return goja.Undefined()
	})
	_ = b.Set("setText", func(call goja.FunctionCall) goja.Value {
		msg, ok := call.Argument(0).(*goja.Object)
		if !ok {
			return goja.Undefined()
		}
		msg.Set("body", call.Argument(1).String())
		return goja.Undefined()
	})
	pulseObj.Set("body", b)
}

// ---- encoding + crypto ----

func buildEncodingCryptoAPI(vm *goja.Runtime, pulseObj *goja.Object) {
	enc := vm.NewObject()
	_ = enc.Set("base64", func(call goja.FunctionCall) goja.Value {
		return vm.ToValue(base64.StdEncoding.EncodeToString([]byte(argString(call, 0))))
	})
	_ = enc.Set("hex", func(call goja.FunctionCall) goja.Value {
		return vm.ToValue(hex.EncodeToString([]byte(argString(call, 0))))
	})
	pulseObj.Set("encoding", enc)

	cr := vm.NewObject()
	_ = cr.Set("sha256", func(call goja.FunctionCall) goja.Value {
		sum := sha256.Sum256([]byte(argString(call, 0)))
		return vm.ToValue(hex.EncodeToString(sum[:]))
	})
	_ = cr.Set("hmacSha256", func(call goja.FunctionCall) goja.Value {
		mac := hmac.New(sha256.New, []byte(argString(call, 0)))
		mac.Write([]byte(argString(call, 1)))
		return vm.ToValue(hex.EncodeToString(mac.Sum(nil)))
	})
	pulseObj.Set("crypto", cr)
}

// ---- small helpers ----

func argString(call goja.FunctionCall, i int) string {
	if len(call.Arguments) <= i {
		return ""
	}
	return call.Argument(i).String()
}

func objString(o *goja.Object, key string) (string, bool) {
	v := o.Get(key)
	if v == nil || v == goja.Undefined() || v == goja.Null() {
		return "", false
	}
	return v.String(), true
}

func makeErr(vm *goja.Runtime, msg string) goja.Value {
	return vm.NewGoError(fmt.Errorf("%s", msg))
}
