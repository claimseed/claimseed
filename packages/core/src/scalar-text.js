// A value a caller passed, as text to check it against a pattern: a string as it is; a number, boolean or big integer
// written out; anything else (an object, an array, a function, a symbol, null) as empty text, which no pattern accepts.
// An object is never converted, so none of its methods (toString, valueOf, Symbol.toPrimitive) runs.
export const scalarText = (v) => (typeof v === 'string' ? v : ['number', 'boolean', 'bigint'].includes(typeof v) ? String(v) : '');
