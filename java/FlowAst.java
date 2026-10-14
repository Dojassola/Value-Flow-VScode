/* Code Flow Lens. JDK source launcher helper: parses only, never runs user code.
 * No annotation processors, build tools, compiler plugins or project classpath. */
import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.tools.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class FlowAst {
  static String text; static CompilationUnitTree unit; static SourcePositions pos;
  static IdentityHashMap<Tree,String> ids = new IdentityHashMap<>();
  static List<String> warnings = new ArrayList<>();
  static long start(Tree n) { return n == null ? 0 : Math.max(0, pos.getStartPosition(unit,n)); }
  static long end(Tree n) { return n == null ? 0 : Math.max(start(n),pos.getEndPosition(unit,n)); }
  static String code(Tree n) { return text.substring((int)Math.min(text.length(),start(n)),(int)Math.min(text.length(),end(n))); }
  static Map<String,Object> map(Object... kv) { Map<String,Object> m=new LinkedHashMap<>(); for(int i=0;i<kv.length;i+=2)m.put((String)kv[i],kv[i+1]);return m; }
  static Map<String,Object> ref(Tree n) {
    String name=code(n), id=ids.get(n);
    if(n instanceof IdentifierTree) { name=((IdentifierTree)n).getName().toString(); if(id==null)id="external:"+name; }
    else if(n instanceof MemberSelectTree) { MemberSelectTree m=(MemberSelectTree)n; id=ref(m.getExpression()).get("id")+"."+m.getIdentifier(); }
    else if(n instanceof ArrayAccessTree) { ArrayAccessTree a=(ArrayAccessTree)n; id=ref(a.getExpression()).get("id")+"[]"; }
    else if(n instanceof VariableTree) { name=((VariableTree)n).getName().toString(); id="decl:"+start(n); }
    else if(id==null)id="external:"+name;
    return map("id",id,"name",name,"start",start(n),"end",end(n));
  }
  static class Effects extends TreeScanner<Void,Void> {
    List<Object> reads=new ArrayList<>(), writes=new ArrayList<>(), calls=new ArrayList<>(); int conditional=0;
    void write(Tree n) { if(n!=null){Map<String,Object> r=ref(n); if(conditional>0)r.put("maybe",true); writes.add(r); if(n instanceof MemberSelectTree)scan(((MemberSelectTree)n).getExpression(),null); if(n instanceof ArrayAccessTree)scan(((ArrayAccessTree)n).getExpression(),null);} }
    @Override public Void visitConditionalExpression(ConditionalExpressionTree n,Void p){scan(n.getCondition(),p);conditional++;scan(n.getTrueExpression(),p);scan(n.getFalseExpression(),p);conditional--;return null;}
    @Override public Void visitBinary(BinaryTree n,Void p){scan(n.getLeftOperand(),p);boolean c=n.getKind()==Tree.Kind.CONDITIONAL_AND||n.getKind()==Tree.Kind.CONDITIONAL_OR;if(c)conditional++;scan(n.getRightOperand(),p);if(c)conditional--;return null;}
    @Override public Void visitIdentifier(IdentifierTree n,Void p){reads.add(ref(n));return null;}
    @Override public Void visitMemberSelect(MemberSelectTree n,Void p){reads.add(ref(n));scan(n.getExpression(),p);return null;}
    @Override public Void visitVariable(VariableTree n,Void p){scan(n.getInitializer(),p);write(n);return null;}
    @Override public Void visitAssignment(AssignmentTree n,Void p){scan(n.getExpression(),p);write(n.getVariable());return null;}
    @Override public Void visitCompoundAssignment(CompoundAssignmentTree n,Void p){scan(n.getVariable(),p);scan(n.getExpression(),p);write(n.getVariable());return null;}
    @Override public Void visitUnary(UnaryTree n,Void p){scan(n.getExpression(),p);String k=n.getKind().name();if(k.contains("INCREMENT")||k.contains("DECREMENT"))write(n.getExpression());return null;}
    @Override public Void visitMethodInvocation(MethodInvocationTree n,Void p){
      Tree callee=n.getMethodSelect();calls.add(map("name",code(callee),"start",start(callee),"end",end(callee)));
      if(callee instanceof MemberSelectTree)scan(((MemberSelectTree)callee).getExpression(),p);
      for(ExpressionTree a:n.getArguments())scan(a,p);
      reads.add(map("id","call-result:"+start(n),"name",code(callee)+"() result","start",start(callee),"end",end(callee),"boundary","opaque-call-result"));return null;
    }
    @Override public Void visitNewClass(NewClassTree n,Void p){for(ExpressionTree a:n.getArguments())scan(a,p);calls.add(map("name","new "+code(n.getIdentifier()),"start",start(n),"end",end(n)));return null;}
    @Override public Void visitLambdaExpression(LambdaExpressionTree n,Void p){return null;}
    @Override public Void visitClass(ClassTree n,Void p){return null;}
    @Override public Void visitMethod(MethodTree n,Void p){return null;}
  }
  static Map<String,Object> atom(Tree n,String label){Effects e=new Effects();e.scan(n,null);return map("start",start(n),"end",end(n),"code",code(n),"name",label,"reads",e.reads,"writes",e.writes,"calls",e.calls);}
  static Object block(List<? extends Tree> body){List<Object> s=new ArrayList<>();if(body!=null)for(Tree t:body)s.add(statement(t));return map("kind","block","statements",s);}
  static Object simple(Tree n,String name){return n==null?null:map("kind","simple","atom",atom(n,name));}
  static Object statement(Tree n){
    if(n==null)return block(null);
    if(n instanceof BlockTree)return block(((BlockTree)n).getStatements());
    if(n instanceof IfTree){IfTree v=(IfTree)n;return map("kind","if","atom",atom(v.getCondition(),"if"),"then",statement(v.getThenStatement()),"else",statement(v.getElseStatement()));}
    if(n instanceof WhileLoopTree){WhileLoopTree v=(WhileLoopTree)n;return map("kind","loop","atom",atom(v.getCondition(),"while"),"body",statement(v.getStatement()));}
    if(n instanceof DoWhileLoopTree){DoWhileLoopTree v=(DoWhileLoopTree)n;return map("kind","do","atom",atom(v.getCondition(),"do while"),"body",statement(v.getStatement()));}
    if(n instanceof ForLoopTree){ForLoopTree v=(ForLoopTree)n;Map<String,Object> cond=v.getCondition()==null?map("start",start(v),"end",start(v),"code","true /* for (;;) */","name","for","reads",new ArrayList<>(),"writes",new ArrayList<>(),"calls",new ArrayList<>(),"always",true):atom(v.getCondition(),"for condition");return map("kind","loop","init",block(v.getInitializer()),"atom",cond,"update",block(v.getUpdate()),"body",statement(v.getStatement()));}
    if(n instanceof EnhancedForLoopTree){EnhancedForLoopTree v=(EnhancedForLoopTree)n;Map<String,Object> a=atom(v.getExpression(),"for each");a.put("writes",Arrays.asList(ref(v.getVariable())));return map("kind","loop","atom",a,"body",statement(v.getStatement()),"iteration",true);}
    if(n instanceof ReturnTree)return map("kind","return","atom",atom(n,"return"));
    if(n instanceof ThrowTree)return map("kind","throw","atom",atom(n,"throw"));
    if(n instanceof BreakTree){BreakTree b=(BreakTree)n;if(b.getLabel()==null)return map("kind","break","atom",atom(n,"break"));}
    if(n instanceof ContinueTree){ContinueTree b=(ContinueTree)n;if(b.getLabel()==null)return map("kind","continue","atom",atom(n,"continue"));}
    if(n instanceof SwitchTree){SwitchTree v=(SwitchTree)n;List<Object> cases=new ArrayList<>();for(CaseTree c:v.getCases()){
      List<? extends StatementTree> statements=c.getStatements();
      if(statements==null){warnings.add("Switch arrow rules/patterns are opaque with this JDK-compatible adapter.");return map("kind","opaque","atom",atom(n,"switch boundary"));}
      cases.add(map("label",c.getExpression()==null?"default":"case "+code(c.getExpression()),"body",block(statements),"fallthrough",true));
    }return map("kind","switch","atom",atom(v.getExpression(),"switch"),"cases",cases);}
    if(n instanceof TryTree||n instanceof LabeledStatementTree||n instanceof SynchronizedTree||n instanceof BreakTree||n instanceof ContinueTree){warnings.add("try/finally, synchronized or labeled jumps are opaque control boundaries.");return map("kind","opaque","atom",atom(n,"opaque control boundary"));}
    return simple(n,n.getKind().name());
  }
  static class Binder extends TreeScanner<Void,Void>{
    Deque<Map<String,String>> scopes=new ArrayDeque<>(); Binder(){scopes.push(new HashMap<>());}
    String lookup(String n){for(Map<String,String> s:scopes)if(s.containsKey(n))return s.get(n);return "external:"+n;}
    @Override public Void visitIdentifier(IdentifierTree n,Void p){ids.put(n,lookup(n.getName().toString()));return null;}
    @Override public Void visitVariable(VariableTree n,Void p){String id="decl:"+start(n);scopes.peek().put(n.getName().toString(),id);ids.put(n,id);scan(n.getInitializer(),p);return null;}
    @Override public Void visitBlock(BlockTree n,Void p){scopes.push(new HashMap<>());super.visitBlock(n,p);scopes.pop();return null;}
    @Override public Void visitClass(ClassTree n,Void p){scopes.push(new HashMap<>());for(Tree m:n.getMembers())if(m instanceof VariableTree)scopes.peek().put(((VariableTree)m).getName().toString(),"decl:"+start(m));super.visitClass(n,p);scopes.pop();return null;}
    @Override public Void visitMethod(MethodTree n,Void p){scopes.push(new HashMap<>());for(VariableTree param:n.getParameters())scan(param,p);scan(n.getBody(),p);scopes.pop();return null;}
    @Override public Void visitForLoop(ForLoopTree n,Void p){scopes.push(new HashMap<>());super.visitForLoop(n,p);scopes.pop();return null;}
    @Override public Void visitEnhancedForLoop(EnhancedForLoopTree n,Void p){scopes.push(new HashMap<>());super.visitEnhancedForLoop(n,p);scopes.pop();return null;}
    @Override public Void visitLambdaExpression(LambdaExpressionTree n,Void p){scopes.push(new HashMap<>());super.visitLambdaExpression(n,p);scopes.pop();return null;}
    @Override public Void visitCatch(CatchTree n,Void p){scopes.push(new HashMap<>());super.visitCatch(n,p);scopes.pop();return null;}
  }
  static String json(Object v){
    if(v==null)return "null";if(v instanceof Boolean||v instanceof Number)return v.toString();
    if(v instanceof Map){List<String> a=new ArrayList<>();for(Map.Entry<?,?> e:((Map<?,?>)v).entrySet())a.add(json(e.getKey().toString())+":"+json(e.getValue()));return "{"+String.join(",",a)+"}";}
    if(v instanceof Iterable){List<String>a=new ArrayList<>();for(Object x:(Iterable<?>)v)a.add(json(x));return "["+String.join(",",a)+"]";}
    String s=v.toString();StringBuilder b=new StringBuilder("\"");for(char c:s.toCharArray()){if(c=='"'||c=='\\')b.append('\\').append(c);else if(c<' ')b.append(String.format("\\u%04x",(int)c));else b.append(c);}return b.append('"').toString();
  }
  public static void main(String[]args)throws Exception{
    byte[] input=System.in.readNBytes(2_000_001);if(input.length>2_000_000)throw new IllegalArgumentException("Source exceeds 2 MB");text=new String(input,StandardCharsets.UTF_8);
    final int offset=Integer.parseInt(args[0]);JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();if(compiler==null)throw new IllegalStateException("A JDK, not just a JRE, is required");
    DiagnosticCollector<JavaFileObject> diagnostics=new DiagnosticCollector<>();
    JavaFileObject file=new SimpleJavaFileObject(URI.create("string:///Input.java"),JavaFileObject.Kind.SOURCE){@Override public CharSequence getCharContent(boolean ignore){return text;}};
    JavacTask task=(JavacTask)compiler.getTask(null,null,diagnostics,Arrays.asList("-proc:none"),null,Arrays.asList(file));
    unit=task.parse().iterator().next();pos=Trees.instance(task).getSourcePositions();new Binder().scan(unit,null);
    final MethodTree[] chosen={null};
    new TreeScanner<Void,Void>(){@Override public Void visitMethod(MethodTree n,Void p){if(n.getBody()!=null&&start(n)<=offset&&offset<=end(n)&&(chosen[0]==null||end(n)-start(n)<end(chosen[0])-start(chosen[0])))chosen[0]=n;return super.visitMethod(n,p);}}.scan(unit,null);
    if(chosen[0]==null)throw new IllegalArgumentException("Select a method, constructor or a symbol inside its body for local Java flow.");
    MethodTree m=chosen[0];List<Object> params=new ArrayList<>();for(VariableTree p:m.getParameters())params.add(ref(p));
    Map<String,Object> entry=map("name",m.getName().toString(),"start",start(m),"end",start(m.getBody())+1,"code",text.substring((int)start(m),(int)start(m.getBody())+1),"reads",new ArrayList<>(),"writes",params,"calls",new ArrayList<>());
    Object body=statement(m.getBody());for(Diagnostic<?> d:diagnostics.getDiagnostics())if(d.getKind()==Diagnostic.Kind.ERROR)warnings.add(d.getMessage(Locale.ROOT));
    System.out.println(json(map("language","java","parser","JDK javac parse-only + lexical binder","entry",entry,"body",body,"warnings",warnings,"components",new ArrayList<>(),"start",start(m),"end",end(m))));
  }
}
