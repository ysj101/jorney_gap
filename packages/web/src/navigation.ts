type Route = { id: string; pattern: string };

/** Match declared templates only; no path, parameter, query or fragment values leave this function. */
export function resolveRoute(
  routes: readonly Route[],
  pathname: string,
  hash = "",
  basePath = "",
): string {
  const hashRoute = hash.startsWith("#/");
  let path = (hashRoute ? hash.slice(1) : pathname).split(/[?#]/, 1)[0] ?? "/";
  if (!hashRoute && basePath) {
    const base = basePath.replace(/\/$/, "");
    if (path === base) path = "/";
    else if (path.startsWith(`${base}/`)) path = path.slice(base.length);
  }
  const segments = path.replace(/\/$/, "").split("/");
  const matches = routes.filter((route) => {
    const pattern = route.pattern.replace(/\/$/, "").split("/");
    return (
      pattern.length === segments.length &&
      pattern.every((part, n) =>
        part.startsWith(":") ? Boolean(segments[n]) : part === segments[n],
      )
    );
  });
  matches.sort(
    (a, b) =>
      b.pattern.split("/").filter((part) => part && !part.startsWith(":"))
        .length -
      a.pattern.split("/").filter((part) => part && !part.startsWith(":"))
        .length,
  );
  return matches[0]?.id ?? "unknown";
}

/** History patches are optional. Foreign patches and nonnative implementations use event fallback. */
export function observeNavigation(
  routes: readonly Route[],
  emit: (routeId: string) => void,
  enabled: () => boolean,
) {
  let stopped = false;
  let last: string | undefined;
  let patched = false;
  let onRoute = emit;
  let canEmit = enabled;
  const history = window.history;
  const restores: Array<() => void> = [];
  const refresh = () => {
    try {
      if (stopped || !canEmit()) return;
      let basePath = "";
      if (document.querySelector("base[href]")) {
        const base = new URL(".", document.baseURI);
        if (base.origin === window.location.origin) basePath = base.pathname;
      }
      const route = resolveRoute(
        routes,
        window.location.pathname,
        window.location.hash,
        basePath,
      );
      if (route === last) return;
      last = route;
      onRoute(route);
    } catch {
      /* Navigation and host exceptions remain independent. */
    }
  };
  window.addEventListener("popstate", refresh);
  window.addEventListener("hashchange", refresh);
  try {
    const prototype: History = Object.getPrototypeOf(history);
    const methods = ["pushState", "replaceState"] as const;
    if (
      methods.every(
        (name) =>
          history[name] === prototype[name] &&
          Function.prototype.toString
            .call(history[name])
            .includes("[native code]"),
      )
    ) {
      for (const name of methods) {
        const original = history[name];
        const descriptor = Object.getOwnPropertyDescriptor(history, name);
        const wrapper: History[typeof name] = function (
          this: History,
          ...args
        ) {
          // Preserve return values and exceptions from the original host operation.
          const result = Reflect.apply(original, this, args);
          refresh();
          return result;
        };
        history[name] = wrapper;
        if (history[name] !== wrapper)
          throw new Error("History patch unavailable");
        restores.push(() => {
          if (history[name] === wrapper) {
            if (descriptor) Object.defineProperty(history, name, descriptor);
            else Reflect.deleteProperty(history, name);
          }
        });
      }
      patched = true;
    }
  } catch {
    for (const restore of restores) {
      try {
        restore();
      } catch {
        /* Retain event fallback. */
      }
    }
  }
  return {
    refresh,
    reset: () => {
      last = undefined;
    },
    isPatched: () => patched,
    stop(): void {
      stopped = true;
      patched = false;
      onRoute = () => {};
      canEmit = () => false;
      window.removeEventListener("popstate", refresh);
      window.removeEventListener("hashchange", refresh);
      for (const restore of restores) {
        try {
          restore();
        } catch {
          /* Never overwrite a foreign SDK. */
        }
      }
    },
  };
}
