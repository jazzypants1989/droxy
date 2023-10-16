export function $(string, fixed = false) {
  return addProxy("$", string, fixed)
}

export function $$(string, fixed = false) {
  return addProxy("$$", string, fixed)
}

export function setErrorHandler(handler) {
  defaultErrorHandler = handler
}

export function promisify(
  fn,
  timeout = 5000,
  meta = { fnName: "anonymous", fnArgs: "unknown" }
) {
  return (...args) => {
    return new Promise((resolve, reject) => {
      let settled = false

      const Resolve = (value) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }

      const Reject = (reason) => {
        if (!settled) {
          settled = true
          reject(reason)
        }
      }

      setTimeout(() => {
        if (!settled) {
          settled = true
          resolve("")
          defaultErrorHandler(
            new Error(`Timeout: ${timeout}ms exceeded.`),
            meta
          )
        }
      }, timeout)

      fn(Resolve, Reject, ...args)
    })
  }
}

function addProxy(type, string, fixed = false) {
  const element = getDOMElement(string, false, type === "$$")

  if (!element[0]) {
    return defaultErrorHandler(
      new Error(`Error with element.`),
      giveContext(type, string)
    )
  }

  return addMethods(type, string, element[1] ? element : element[0], fixed)
}

function createQueue() {
  const priorityQueue = []
  const mainQueue = []
  const deferredQueue = []
  let isRunning = false

  async function runQueue() {
    if (isRunning) return
    isRunning = true

    while (priorityQueue.length > 0 || mainQueue.length > 0) {
      if (priorityQueue.length > 0) {
        const { fn, args } = priorityQueue.shift()
        await fn(...args)
      } else if (mainQueue.length > 0) {
        const fn = mainQueue.shift()
        await fn()
      }
    }

    if (
      deferredQueue.length > 0 &&
      mainQueue.length === 0 &&
      priorityQueue.length === 0
    ) {
      while (deferredQueue.length > 0) {
        const { fn, args } = deferredQueue.shift()
        await fn(...args)
      }
    }

    isRunning = false
  }

  function addToQueue(fn) {
    mainQueue.push(fn)
    runQueue()
  }

  function prioritize(fn, args = []) {
    priorityQueue.push({ fn, args })
    runQueue()
  }

  function defer(fn, args = []) {
    deferredQueue.push({ fn, args })
    if (!isRunning) {
      runQueue()
    }
  }

  return {
    addToQueue,
    prioritize,
    defer,
  }
}

function createApplyFunc(addToQueue, proxy) {
  const isThenable = (value) => value && typeof value.then === "function"

  return function applyFunc(fn, context) {
    return (...args) => {
      addToQueue(async () => {
        try {
          const resolvedArgs = []
          for (const arg of args) {
            resolvedArgs.push(isThenable(arg) ? await arg : arg)
          }
          const result = fn(...resolvedArgs)
          if (isThenable(result)) {
            await result
          }
        } catch (error) {
          defaultErrorHandler(error, context)
        }
      })
      return proxy()
    }
  }
}

function handlerMaker(element, customMethods) {
  return {
    get(_, prop) {
      if (prop === "raw") {
        return element
      }

      if (prop in customMethods) {
        return customMethods[prop]
      }

      if (Array.isArray(element) && element[prop]) {
        return typeof element[prop] === "function"
          ? element[prop].bind(element)
          : element[prop]
      }

      return element[prop]
    },
    set(_, prop, value) {
      if (prop in customMethods) {
        customMethods[prop] = value
        return true
      }
      element[prop] = value
      return true
    },
  }
}

function addMethods(type, selector, target, fixed = false) {
  let proxy = null
  let isSingle = type === "$"

  const toOneOrMany = (func) => {
    return isSingle ? func(target) : target.forEach((el) => func(el))
  }

  const { addToQueue, prioritize, defer } = createQueue()
  const applyFunc = createApplyFunc(addToQueue, () => proxy)

  const makeMethod = (action, context) => {
    return applyFunc((...args) => {
      toOneOrMany((el) => action(el, ...args))
    }, giveContext(context, selector))
  }

  const customMethods = {
    on: makeMethod((el, ev, fn) => {
      el.addEventListener(ev, (...args) => {
        prioritize(fn, args)
      })
    }, "on"),

    once: makeMethod((el, ev, fn) => {
      el.addEventListener(
        ev,
        (...args) => {
          prioritize(fn, args)
        },
        { once: true }
      )
    }, "once"),

    delegate: makeMethod((el, event, subSelector, handler) => {
      el.addEventListener(event, (e) => {
        if (e.target.matches(subSelector)) {
          prioritize(handler, [e])
        }
      })
    }, "delegate"),

    off: makeMethod((el, ev, fn) => {
      el.removeEventListener(ev, fn)
    }, "off"),

    html: makeMethod((el, newHtml) => (el.innerHTML = newHtml), "html"),

    text: makeMethod((el, newText) => (el.textContent = newText), "text"),

    sanitize: makeMethod(
      (el, newHtml, sanitizer) => el.setHTML(newHtml, sanitizer),
      "sanitize"
    ),

    val: makeMethod((el, newValue) => setFormElementValue(el, newValue), "val"),

    css: makeMethod(
      (el, prop, value) => stringOrObject(el.style, prop, value),
      "css"
    ),

    addStyleSheet: makeMethod(
      (_, rules) => addStyleSheet(rules),
      "addStyleSheet"
    ),

    addClass: makeMethod(Class("add"), "addClass"),

    removeClass: makeMethod(Class("remove"), "removeClass"),

    toggleClass: makeMethod(Class("toggle"), "toggleClass"),

    set: makeMethod(
      (el, attr, value = "") => stringOrObject(el, attr, value, true),
      "set"
    ),

    unset: makeMethod((el, attr) => el.removeAttribute(attr), "unset"),

    toggle: makeMethod((el, attr) => el.toggleAttribute(attr), "toggle"),

    data: makeMethod(
      (el, keyOrObj, value) => stringOrObject(el.dataset, keyOrObj, value),
      "data"
    ),

    attach: makeMethod((el, ...children) => attach(el, ...children), "attach"),

    cloneTo: makeMethod((el, parentSelector, options) => {
      moveOrClone(el, parentSelector, { mode: "clone", ...options })
    }, "cloneTo"),

    moveTo: makeMethod((el, parentSelector, options) => {
      moveOrClone(el, parentSelector, { mode: "move", ...options })
    }, "moveTo"),

    become: makeMethod((el, replacements, options) => {
      become(el, replacements, options)
    }, "become"),

    purge: makeMethod((el) => el.remove(), "purge"),

    do: makeMethod((el, fn) => {
      const wrappedElement = addMethods(type, selector, el)
      fn(wrappedElement)
    }),

    defer: makeMethod((el, fn) => {
      const wrappedElement = addMethods(type, selector, el)
      defer(fn, [wrappedElement])
    }, "defer"),

    transition: applyFunc(
      (keyframes, options) =>
        transition(
          Array.isArray(target) ? target : [target],
          keyframes,
          options
        ),
      giveContext("transition", selector)
    ),

    wait: applyFunc(
      (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
      giveContext("wait", selector)
    ),
  }

  function updateProxy(newTarget) {
    const handler = handlerMaker(newTarget, customMethods)
    const proxy = new Proxy(customMethods, handler)
    proxy.raw = newTarget
    isSingle = !(newTarget instanceof Array)
    return proxy
  }

  proxy = updateProxy(target)
  return proxy
}
function setFormElementValue(element, value) {
  if (element instanceof HTMLInputElement) {
    const inputTypes = {
      checkbox: () => (element.checked = !!value),
      radio: () => (element.checked = element.value === value),
      file: () => (element.files = value),
      default: () => {
        if (typeof value === "string") element.value = value
      },
    }
    const handler = inputTypes[element.type] || inputTypes.default
    return handler()
  } else if (element instanceof HTMLSelectElement) {
    if (element.multiple && Array.isArray(value)) {
      for (let option of element.options) {
        option.selected = value.includes(option.value)
      }
    } else if (typeof value === "string" || typeof value === "number") {
      element.value = value.toString()
    }
  } else if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLButtonElement
  ) {
    element.value = value
  } else {
    element.textContent = value
  }
}

function Class(type) {
  return (el, ...classes) => el.classList[type](...classes)
}

function stringOrObject(prop, stringOrObj, value, attr) {
  if (typeof stringOrObj === "string") {
    attr ? prop.setAttribute(stringOrObj, value) : (prop[stringOrObj] = value)
  } else if (typeof stringOrObj === "object") {
    Object.assign(prop, stringOrObj)
  }
}

function addStyleSheet(rules) {
  const style = document.createElement("style")
  style.textContent = rules
  document.head.appendChild(style)
}

function attach(element, ...args) {
  const options =
    args[args.length - 1] instanceof Object &&
    ("sanitize" in args[args.length - 1] || "position" in args[args.length - 1])
      ? args.pop()
      : {}

  const children = args.flat()

  modifyDOM(element, children, options)
}

function moveOrClone(elements, parentSelector, options = {}) {
  let parents = getDOMElement(parentSelector, options.sanitize, options.all)

  if (!Array.isArray(parents)) {
    parents = [parents]
  }

  if (!parents.length) return

  const children = Array.isArray(elements) ? elements : [elements].flat()

  parents.forEach((parent) => {
    modifyDOM(parent, children, options)
  })
}

function become(
  elements,
  replacements,
  options = { mode: "clone", match: "cycle" }
) {
  const handleReplacement = (element, replacement) => {
    if (!replacement) return
    const newElement =
      options.mode === "clone" ? replacement.cloneNode(true) : replacement
    element.replaceWith(newElement)
  }
  const proxyOrDOM = (candidate) => candidate.raw || candidate
  const makeArray = (candidate) =>
    Array.isArray(candidate) ? candidate : [candidate]

  const elementsArray = makeArray(proxyOrDOM(elements))
  const replacementsArray = makeArray(proxyOrDOM(replacements))

  elementsArray.forEach((element, index) => {
    const replacement =
      options.match === "cycle"
        ? replacementsArray[index % replacementsArray.length]
        : replacementsArray[index] || null

    if (replacement) {
      handleReplacement(element, replacement)
    } else if (options.match === "remove") {
      element.remove()
    }
  })
}

function transition(elements, keyframes, options) {
  const animations = elements.map((element) =>
    element.animate(keyframes, options)
  )
  return Promise.all(animations.map((animation) => animation.finished))
}

function modifyDOM(parent, children, options) {
  const { position = "append", sanitize = true, mode = "move" } = options

  const DOMActions = {
    append: (parent, child) => parent.append(child),
    prepend: (parent, child) => parent.prepend(child),
    before: (parent, child) => parent.before(child),
    after: (parent, child) => parent.after(child),
  }

  const getCloneOrNode =
    mode === "clone" ? (el) => el.cloneNode(true) : (el) => el

  children.forEach((child) => {
    const domElements = getDOMElement(child, sanitize)
    domElements.forEach((domElement) => {
      DOMActions[position](parent, getCloneOrNode(domElement))
    })
  })
}

function getDOMElement(item, sanitize = true, all = false) {
  return typeof item === "string" && item.trim().startsWith("<")
    ? createDOMFromString(item, sanitize) // If it's an HTML string, create DOM elements from it
    : item instanceof HTMLElement // If it's already a DOM element, return it
    ? [item]
    : all // If the all flag is set, return all matching elements from the DOM
    ? Array.from(document.querySelectorAll(item))
    : [document.querySelector(item)] // Otherwise, return the first matching element from the DOM as an array
}

function createDOMFromString(string, sanitize = true) {
  const div = document.createElement("div")
  sanitize ? div.setHTML(string) : (div.innerHTML = string)
  return Array.from(div.children)
}

let defaultErrorHandler = (error, context) => {
  typeof context === "string"
    ? console.error(`${context}\n`, error)
    : console.error(context, error)
}

function giveContext(methodName, selector) {
  const message =
    methodName === "$"
      ? `$${selector}`
      : methodName === "$$"
      ? `$$${selector}`
      : `The method: ${methodName} called on: ${selector}`

  return message
}
