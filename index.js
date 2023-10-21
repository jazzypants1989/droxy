export function $(selector, fixed = false) {
  return createProxy("$", selector, fixed)
}

export function $$(selector, fixed = false) {
  return createProxy("$$", selector, fixed)
}

function createProxy(type, selector, fixed = false) {
  const elements = getDOMElement(selector, {
    all: type === "$$",
    sanitize: false,
  })

  if (!elements[0]) {
    console.warn(`No elements found for selector: ${selector}`)
  }

  return addMethods(selector, elements)
}

export function createQueue() {
  const mainQueue = []
  const deferredQueue = []
  let isRunning = false

  async function runQueue() {
    if (isRunning) return
    isRunning = true

    while (mainQueue.length > 0) {
      const fn = mainQueue.shift()
      await fn()
    }

    if (deferredQueue.length > 0 && mainQueue.length === 0) {
      while (deferredQueue.length > 0) {
        const { fn, args } = deferredQueue.shift()
        await eachArgument(fn, args)
      }
    }

    isRunning = false
  }

  function addToQueue(fn) {
    mainQueue.push(fn)
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
    defer,
  }
}

export function queueAndReturn(addToQueue, getProxy) {
  return function queueFunction(fn, eager = true) {
    return (...args) => {
      addToQueue(async () => {
        try {
          await eachArgument(fn, args, eager)
        } catch (error) {
          console.error(error)
        }
      })
      return getProxy()
    }
  }
}

export function handlerMaker(elements, customMethods) {
  return {
    get(_, prop) {
      if (elements.length && elements.length === 1) {
        elements = elements[0]
      }

      if (prop === "raw") {
        return elements
      }

      if (prop in customMethods) {
        return customMethods[prop]
      }

      return typeof elements[prop] === "function"
        ? elements[prop].bind(elements)
        : elements[prop]
    },
  }
}

async function eachArgument(fn, args, eager = true) {
  const isThenable = (value) => value && typeof value.then === "function"
  const resolvedArgs = []
  for (const arg of args) {
    resolvedArgs.push(isThenable(arg) && eager ? await arg : arg)
  }
  const result = fn(...resolvedArgs)
  if (isThenable(result)) {
    await result
  }
}
export function addMethods(selector, target) {
  let proxy = null

  const { addToQueue, defer } = createQueue()
  const queueFunction = queueAndReturn(addToQueue, () => proxy)

  const makeMethod = (action, context) => {
    return queueFunction(async (...args) => {
      await Promise.all(target.map((el) => action(el, ...args)))
    })
  }

  const customMethods = {
    on: makeMethod((el, ev, fn) => {
      el.addEventListener(ev, fn)
    }),

    once: makeMethod((el, ev, fn) => {
      el.addEventListener(ev, fn, { once: true })
    }),

    delegate: makeMethod((el, ev, selector, fn) => {
      el.addEventListener(ev, (event) => {
        if (event.target.matches(selector)) {
          fn(event)
        }
      })
    }),

    off: makeMethod((el, ev, fn) => {
      el.removeEventListener(ev, fn)
    }),

    html: makeMethod((el, newHtml, outer) => {
      if (outer) {
        const nextSibling = el.nextSibling // We need to get the nextSibling before removing the element
        el.outerHTML = newHtml // Otherwise, we lose the reference, and the proxy is empty

        const newElement = nextSibling // If nextSibling is null, then we're at the end of the list
          ? nextSibling.previousSibling // So, we get the previousSibling from where we were
          : el.parentElement.lastElementChild // Otherwise, we get the lastElementChild from the parent

        target = [newElement]
        proxy = updateProxy(target)
      } else {
        el.innerHTML = newHtml
      }
    }),

    text: makeMethod((el, newText) => (el.textContent = newText)),

    sanitize: makeMethod((el, newHtml, sanitizer) =>
      el.setHTML(newHtml, sanitizer)
    ),

    val: makeMethod((el, newValue) => setFormElementValue(el, newValue)),

    css: makeMethod((el, prop, value) => parseArgument(el.style, prop, value)),

    addStyleSheet: makeMethod((_, rules) => addStyleSheet(rules)),

    addClass: makeMethod(Class("add")),

    removeClass: makeMethod(Class("remove")),

    toggleClass: makeMethod(Class("toggle")),

    set: makeMethod((el, attr, value = "") =>
      parseArgument(el, attr, value, true)
    ),

    unset: makeMethod((el, attr) => el.removeAttribute(attr)),

    toggle: makeMethod((el, attr) => el.toggleAttribute(attr)),

    data: makeMethod((el, key, value) => parseArgument(el.dataset, key, value)),

    attach: makeMethod((el, ...children) => attach(el, ...children)),

    cloneTo: makeMethod((el, parentSelector, options) => {
      moveOrClone(el, parentSelector, { mode: "clone", ...options })
    }),

    moveTo: makeMethod((el, parentSelector, options) => {
      moveOrClone(el, parentSelector, options)
    }),

    become: makeMethod((el, replacements, options) => {
      become(el, replacements, options)
    }),

    purge: makeMethod((el) => el.remove()),

    do: makeMethod(async (el, fn) => {
      const wrappedElement = addMethods(selector, [el])
      return await fn(wrappedElement)
    }),

    defer: makeMethod((el, fn) => {
      const wrappedElement = addMethods(selector, [el])
      return defer(fn, [wrappedElement])
    }),

    transition: makeMethod((el, keyframes, options) => {
      return el.animate(keyframes, options).finished
    }),

    wait: makeMethod((el, duration) => {
      return new Promise((resolve) => setTimeout(resolve, duration))
    }),
  }

  function updateProxy(newTarget) {
    const handler = handlerMaker(newTarget, customMethods)
    const proxy = new Proxy(customMethods, handler)
    proxy.raw = newTarget
    return proxy
  }

  proxy = updateProxy(target)
  return proxy
}
export function setFormElementValue(element, value) {
  if (element instanceof HTMLInputElement) {
    const inputTypes = {
      checkbox: () => (element.checked = !!value),
      radio: () => (element.checked = element.value === value),
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

export function parseArgument(prop, stringOrObj, value, attr) {
  if (typeof stringOrObj === "string") {
    attr ? prop.setAttribute(stringOrObj, value) : (prop[stringOrObj] = value)
  } else if (typeof stringOrObj === "object") {
    Object.assign(prop, stringOrObj)
  }
}

export function addStyleSheet(rules) {
  const importantRules = rules.trim().split(";").join(" !important;")
  const style = document.createElement("style")
  style.textContent = importantRules
  document.head.appendChild(style)
}

export function Class(type) {
  return (el, ...classes) => el.classList[type](...classes)
}

export function attach(element, ...args) {
  const options =
    args[args.length - 1] instanceof Object &&
    ("sanitize" in args[args.length - 1] || "position" in args[args.length - 1])
      ? args.pop()
      : {}

  const children = args.flat()

  if ((children instanceof NodeList || Array.isArray(children)) && !options) {
    options.all = true
  }

  modifyDOM(element, children, options)
}

export function moveOrClone(elements, parentSelector, options = {}) {
  let parents = getDOMElement(parentSelector, options)

  const children = Array.isArray(elements) ? elements : [elements].flat()

  parents.forEach((parent) => {
    modifyDOM(parent, children, options)
  })
}

export function become(elements, replacements, options = { mode: "clone" }) {
  const handleReplacement = (element, replacement) => {
    if (!replacement) return
    const newElement =
      options.mode === "clone" ? replacement.cloneNode(true) : replacement
    element.replaceWith(newElement)
  }
  const proxyOrDOM = (candidate) => candidate.raw || candidate
  const makeArray = (candidate) => {
    if (Array.isArray(candidate)) return candidate
    if (candidate instanceof HTMLElement) return [candidate]
    if (candidate instanceof NodeList) return Array.from(candidate)
    return []
  }

  const elementsArray = makeArray(proxyOrDOM(elements))
  const replacementsArray = makeArray(proxyOrDOM(replacements))

  elementsArray.forEach((element, index) =>
    handleReplacement(element, replacementsArray[index])
  )
}

export function modifyDOM(parent, children, options) {
  const {
    position = "append",
    sanitize = true,
    mode = "move",
    sanitizer,
    all,
  } = options

  const DOMActions = {
    append: (parent, child) => parent.append(child),
    prepend: (parent, child) => parent.prepend(child),
    before: (parent, child) => parent.before(child),
    after: (parent, child) => parent.after(child),
  }

  const getCloneOrNode =
    mode === "clone" ? (el) => el.cloneNode(true) : (el) => el

  children.forEach((child) => {
    const domElements = getDOMElement(child, { sanitize, sanitizer, all })
    domElements.forEach((domElement) => {
      DOMActions[position](parent, getCloneOrNode(domElement))
    })
  })
}

export function getDOMElement(item, options) {
  return typeof item === "string" && item.trim().startsWith("<") // If it's an HTML string,
    ? createDOMFromString(item, options) // create DOM elements from it
    : item instanceof HTMLElement // If it's already a DOM element
    ? [item] // return it as an array
    : item instanceof NodeList // If it's a NodeList
    ? Array.from(item) // return it as an array
    : options.all // If the all flag is set
    ? Array.from(document.querySelectorAll(item)) // return all matching elements from the DOM as an array
    : [document.querySelector(item)] // Otherwise, return the first matching element from the DOM as an array
}

export function createDOMFromString(string, { sanitize = true, sanitizer }) {
  const div = document.createElement("div")
  sanitize ? div.setHTML(string, sanitizer) : (div.innerHTML = string)
  return Array.from(div.children)
}
