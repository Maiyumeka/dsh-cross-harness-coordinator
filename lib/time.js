// Internal host dependency. Endpoint definitions cannot override time or deadlines.
export const systemClock=Object.freeze({
 now:()=>Date.now(),
 setTimeout:(callback,ms)=>setTimeout(callback,ms),
 clearTimeout:timer=>clearTimeout(timer),
});
