const methods = ["all", "get", "post", "put", "patch", "delete", "options", "head", "use"];

function wrapHandler(handler) {
  if (typeof handler !== "function" || handler.length === 4) {
    return handler;
  }

  return function wrappedHandler(req, res, next) {
    try {
      const result = handler(req, res, next);

      if (result && typeof result.catch === "function") {
        result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

function wrapArgument(argument) {
  if (Array.isArray(argument)) {
    return argument.map(wrapArgument);
  }

  return wrapHandler(argument);
}

function patchExpressRouter(express) {
  if (express.__asyncRouteErrorsPatched) {
    return;
  }

  const originalRouter = express.Router;

  express.Router = function patchedRouter(...args) {
    const router = originalRouter.apply(this, args);

    methods.forEach((method) => {
      const originalMethod = router[method];

      if (typeof originalMethod !== "function") {
        return;
      }

      router[method] = function patchedRouteMethod(...routeArgs) {
        return originalMethod.apply(this, routeArgs.map(wrapArgument));
      };
    });

    return router;
  };

  express.__asyncRouteErrorsPatched = true;
}

module.exports = {
  patchExpressRouter
};
