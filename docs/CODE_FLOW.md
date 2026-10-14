# Code Flow Lens: static flow semantics

Code Flow Lens 0.11.1 has three related but deliberately different static analyses:

1. **Code flow**: intraprocedural control-flow graph and local reaching definitions.
2. **Value flow**: bounded interprocedural provenance/destination graph for TS/JS/TSX/JSX.
3. **Static simulation**: bounded abstract interpretation after injecting a user-provided value into a local symbol.

They are not a debugger recording, full SSA optimizer, complete whole-program taint engine, bytecode disassembler or deterministic symbolic executor.

## Code-flow edges

`next`, `true`, `false`, `case`, `default`, `continue`, `break`, `return` and `throw` are AST control edges. In the ordinary Code-flow view conditions are not evaluated. Selecting true/false in **Walk path** records a manually chosen static path.

`data` links a possible prior producer to a local read. A definite local assignment kills previous definitions of the same binding; may-writes preserve alternatives. Branch merges and loops union candidate definitions. This analysis is path-insensitive and deliberately conservative around heap/object aliasing.

`unknown_control` marks constructs summarized instead of modeled precisely.

## Interprocedural Value Flow

The Value Flow engine uses the embedded TypeScript Program/TypeChecker plus bounded reference discovery. Supported edge families include:

- `assign`: initializer/assignment -> binding;
- `argument`: call argument -> resolved function parameter;
- `return`: expression -> function return value;
- `call_return`: function return -> receiving variable/call site;
- `destructure`: object/array member -> destructured binding;
- `object_property`: value -> object property;
- `object_contains`: property -> containing object;
- `jsx_prop`: value -> functional component prop/binding when resolvable.

The tracer can continue through common React forms such as destructured function props and `props.name` reads. Dynamic factories, indirect dispatch, arbitrary framework injection, unresolved external libraries, reflection/proxies and complex heap aliases remain conservative boundaries.

An edge means **may feed**, not **did feed at runtime**.

## Multi-symbol correlation

Correlation merges bounded neighborhoods for 2 to 8 selected symbols. It records reasons instead of a single generic score:

- `common_destination`
- `common_origin`
- `shared_parameter`
- `shared_write_target`
- `shared_object_target`
- `shared_function_scope`
- `shared_call_site`
- `common_caller`
- `common_callee`
- `direct_collision`

Value intersections and structural intersections are kept distinct in edge types. A shared scope/caller does not imply values interact. A shared write target is a stronger collision candidate, but still static evidence rather than runtime proof.

## Static value simulation

Simulation starts at the function containing the selected variable/parameter. The user supplies a JSON/primitive value. The interpreter then executes a **safe AST subset inside the worker**; it does not call `eval`, import the selected module or execute workspace code.

The current subset includes:

- local parameters and declarations, including object/array binding patterns;
- objects/arrays and property/element reads when the base is known;
- common arithmetic, comparison and logical operators;
- assignments and common compound assignments;
- prefix/postfix increments;
- `if`, conditional expressions and `switch`;
- bounded simple loops;
- direct calls to statically resolved workspace functions, with a call-depth budget;
- returns and throws.

External calls, async scheduling, browser APIs, getters/proxies, dynamic dispatch and unsupported statements produce `<unknown>` or an explicit conservative warning. Unknown branch environments are cloned before alternatives are interpreted so mutations in one simulated branch do not leak into the other.

The simulation result is a scenario explorer, not a test oracle.

## TypeScript engine

TypeScript 5.8.3 is bundled under its upstream license/notices. In `semanticEngine=local`, imports, references and calls are resolved by the TypeScript Language Service inside a killable Worker. The selected package is indexed on demand even when monorepo root discovery is truncated.

The ordinary semantic query budget and the heavier value-analysis budget are separate. A timed-out worker is terminated instead of leaving an old query consuming the queue. Cancellation of an active local query also stops that worker.

Open TS/JS editor buffers are overlaid so unsaved text participates in analysis.

## Java

Java cross-file semantic relationships use the Code Flow Lens lightweight index. Local method CFG/data-flow can use the JDK helper, which invokes `JavacTask.parse()` with annotation processing disabled and does not execute project classes.

The 0.9 interprocedural Value Flow, multi-symbol value correlation and Static Simulation are TS/JS/TSX/JSX features. Java retains semantic relationships plus method-level CFG/data-flow.

## React hierarchy and preview

A static JSX hierarchy edge proves a resolved syntactic JSX use, not that a component is mounted on every render. The React preview is a separate, explicitly executable feature requiring workspace trust.

## Source and exports

Coordinates are 1-based lines/UTF-16 columns. Graph exports contain the currently loaded source/code snippets and local paths. Review JSON before sharing it.
