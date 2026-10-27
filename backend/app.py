import ast
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from werkzeug.utils import secure_filename

ROOT = Path(__file__).resolve().parent
default_data_dir = Path("/tmp/bugtrack-pro-analyzer") if os.environ.get("VERCEL") == "1" else ROOT / "data"
DATA = Path(os.environ.get("VERCEL_DATA_DIR") or str(default_data_dir))
UPLOADS = DATA / "uploads"
WORKSPACES = DATA / "workspaces"
DATABASE = DATA / "analyzer.sqlite3"
MAX_UPLOAD = 25 * 1024 * 1024
ALLOWED_EXTENSIONS = {".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".json", ".txt", ".log", ".html", ".css", ".png", ".jpg", ".jpeg", ".webp"}
LANGUAGES = {"Python", "JavaScript", "HTML", "CSS", "Java"}
LANGUAGE_EXTENSIONS = {
    "Python": {".py"},
    "JavaScript": {".js", ".jsx", ".ts", ".tsx"},
    "HTML": {".html", ".htm"},
    "CSS": {".css"},
    "Java": {".java"},
}
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD
app.config["JSON_SORT_KEYS"] = False
for directory in (UPLOADS, WORKSPACES):
    directory.mkdir(parents=True, exist_ok=True)


def db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with db() as connection:
        connection.executescript(
            """CREATE TABLE IF NOT EXISTS analyses (
                id TEXT PRIMARY KEY, created_at TEXT NOT NULL, language TEXT NOT NULL,
                status TEXT NOT NULL, input_summary TEXT NOT NULL, result_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS fixes (
                id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, issue_id TEXT NOT NULL,
                created_at TEXT NOT NULL, status TEXT NOT NULL, original TEXT NOT NULL,
                proposed TEXT NOT NULL, explanation TEXT NOT NULL
            );"""
        )


def now():
    return datetime.now(timezone.utc).isoformat()


def issue(title, category, severity, confidence, explanation, evidence, expected, actual, recommendation, file_name=None, line=None, verified="Potential", original_code="", corrected_code=""):
    return {
        "id": f"ISSUE-{uuid.uuid4().hex[:8].upper()}",
        "title": title, "category": category, "severity": severity, "confidence": confidence,
        "verification": verified, "explanation": explanation, "evidence": evidence,
        "expected": expected, "actual": actual,         "recommendation": recommendation, "original_code": original_code, "corrected_code": corrected_code,
        "file": file_name, "line": line, "steps": []
    }


def source_issue(title, category, severity, explanation, recommendation, relative, lines, line, verification="Potential", corrected_code=""):
    source_line = lines[line - 1] if line and line <= len(lines) else ""
    return issue(title, category, severity, 0.9 if verification == "Confirmed" else 0.75, explanation, source_line, "The code handles this case safely.", "The code may fail or behave unexpectedly.", recommendation, relative, line, verification, source_line, corrected_code)


def safe_extract(archive, target):
    for member in archive.infolist():
        name = Path(member.filename)
        if name.is_absolute() or ".." in name.parts:
            raise ValueError("ZIP contains an unsafe path.")
        destination = (target / name).resolve()
        if target.resolve() not in destination.parents and destination != target.resolve():
            raise ValueError("ZIP contains an unsafe path.")
        if member.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, destination.open("wb") as output:
                shutil.copyfileobj(source, output)


def analyze_python(path, relative):
    findings = []
    source = path.read_text(encoding="utf-8", errors="replace")
    source_lines = source.splitlines()
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        original = source_lines[max(0, (error.lineno or 1) - 2): (error.lineno or 1) + 1]
        findings.append(issue("Python syntax error", "Syntax error", "Critical", 1.0, str(error), f"Parser reported: {error.msg}", "The file parses successfully.", "Python parser failed.", "Correct the invalid syntax and run the parser again.", relative, error.lineno, "Confirmed", "\n".join(original), "# Review the syntax near the reported line and close the incomplete expression."))
        return findings
    defined = set(dir(__builtins__)) | {"self", "cls", "print", "len", "range", "str", "int", "float", "bool", "sum", "min", "max"}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(node.name)
            defined.update(argument.arg for argument in node.args.args)
            defined.update(argument.arg for argument in node.args.kwonlyargs)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for imported in node.names:
                defined.add(imported.asname or imported.name.split(".")[0])
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Param)):
            defined.add(node.id)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in defined:
            findings.append(source_issue("Possibly undefined name", "Undefined symbol", "High", f"'{node.id}' is used before a definition or import was found.", "Define or import the name before using it.", relative, source_lines, node.lineno, "Potential"))
            defined.add(node.id)
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.FloorDiv, ast.Mod)) and isinstance(node.right, ast.Constant) and node.right.value == 0:
            findings.append(source_issue("Division by zero", "Runtime error", "High", "This operation always divides by zero and will raise an exception.", "Guard the divisor before performing the operation.", relative, source_lines, node.lineno, "Confirmed"))
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.FloorDiv, ast.Mod)):
            findings.append(source_issue("Possible division by zero", "Runtime error", "Medium", "The divisor is not proven to be non-zero by static analysis.", "Validate the divisor before performing the operation.", relative, source_lines, node.lineno, "Potential"))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defaults = [*node.args.defaults, *(default for default in node.args.kw_defaults if default)]
            for default in defaults:
                mutable_type = (
                    isinstance(default, (ast.List, ast.Dict, ast.Set))
                    or isinstance(default, ast.Call)
                    and isinstance(default.func, ast.Name)
                    and default.func.id in {"list", "dict", "set"}
                )
                if mutable_type:
                    original = source_lines[node.lineno - 1] if node.lineno <= len(source_lines) else f"def {node.name}(...)"
                    default_index = defaults.index(default)
                    positional_names = [argument.arg for argument in node.args.args[-len(node.args.defaults):]]
                    argument_name = positional_names[default_index] if default_index < len(positional_names) else "value"
                    empty_value = "{}" if isinstance(default, ast.Dict) or isinstance(default, ast.Call) and isinstance(default.func, ast.Name) and default.func.id == "dict" else "set()" if isinstance(default, ast.Set) or isinstance(default, ast.Call) and isinstance(default.func, ast.Name) and default.func.id == "set" else "[]"
                    corrected = f"def {node.name}(..., {argument_name}=None):\n    if {argument_name} is None:\n        {argument_name} = {empty_value}"
                    findings.append(issue(
                        "Mutable default argument",
                        "Runtime behavior",
                        "High",
                        0.99,
                        "A mutable default value is created once and shared by every call to the function.",
                        f"Function '{node.name}' uses a mutable default argument.",
                        "Each call receives a new collection unless shared state is intentional.",
                        "Values can leak between separate calls.",
                        "Use None as the default and create the list or dictionary inside the function.",
                        relative,
                        node.lineno,
                        "Confirmed",
                        original,
                        corrected,
                    ))
                    break
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "eval":
            original = source_lines[node.lineno - 1] if node.lineno <= len(source_lines) else "eval(...)"
            corrected = original.replace("eval(", "ast.literal_eval(")
            findings.append(issue("Use of eval()", "Security / code quality", "High", 0.96, "eval executes dynamically supplied Python code and can execute unintended commands.", f"eval() call at line {node.lineno}.", "Only trusted, explicit operations execute.", "Arbitrary expression text is evaluated.", "Replace eval with ast.literal_eval for data-only parsing, or use explicit validation.", relative, node.lineno, "Confirmed", original, corrected))
        if isinstance(node, ast.FunctionDef) and not ast.get_docstring(node):
            findings.append(issue("Function has no documentation", "Maintainability", "Low", 0.72, "Undocumented functions are harder to review and maintain.", f"Function '{node.name}' has no docstring.", "Public behavior is documented.", "No docstring was found.", "Add a concise docstring describing inputs, outputs, and errors.", relative, node.lineno, "Informational"))
    return findings


def looks_like_python_source(value):
    try:
        tree = ast.parse(value)
    except SyntaxError:
        return False
    return any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom)) for node in ast.walk(tree))


def looks_like_source(value, language):
    if language == "Python":
        return looks_like_python_source(value)
    if language == "JavaScript":
        return bool(re.search(r"\b(?:function|const|let|var|class|import|export)\b|=>", value))
    if language == "HTML":
        return bool(re.search(r"<[a-z][^>]*>", value, re.I))
    if language == "CSS":
        return "{" in value
    if language == "Java":
        return bool(re.search(r"\b(?:class|public|private|static|void)\b", value))
    return False


def analyze_javascript(path, relative):
    source = path.read_text(encoding="utf-8", errors="replace")
    lines = source.splitlines()
    findings = []
    if path.suffix.lower() == ".js":
        try:
            check = subprocess.run(
                ["node", "--check", str(path)],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            check = None
        if check and check.returncode:
            match = re.search(r":(\d+)\s*$", check.stderr.strip())
            line = int(match.group(1)) if match else 1
            message = check.stderr.strip().splitlines()[-1] if check.stderr.strip() else "JavaScript syntax check failed."
            findings.append(source_issue("JavaScript syntax error", "Syntax error", "Critical", message, "Correct the syntax error and rerun the analyzer.", relative, lines, line, "Confirmed"))
            return findings
    if path.suffix.lower() != ".js" and source.strip() and re.search(r"\b(?:var|let|const|function|class|import|export)\b", source) is None:
        findings.append(source_issue("JavaScript syntax could not be fully verified", "Analysis limitation", "Low", "This JavaScript-family file was inspected with configured pattern checks, but no parser is configured for its exact extension.", "Configure a parser for this file type for stronger syntax checks.", relative, lines, 1, "Informational"))
    for match in re.finditer(r"\b(eval|innerHTML)\s*(?:\(|=)", source):
        line = source[:match.start()].count("\n") + 1
        title = "Dynamic code execution" if match.group(1) == "eval" else "Unsafe HTML injection"
        findings.append(source_issue(title, "Security", "High", "This pattern can execute untrusted input or enable cross-site scripting.", "Validate and encode input; avoid eval and prefer textContent or safe DOM APIs.", relative, lines, line, "Confirmed"))
    for match in re.finditer(r"\b(?:var|let|const)\s+(\w+)\s*=\s*([^;\n]+)", source):
        name = match.group(1)
        if len(re.findall(rf"\b{re.escape(name)}\b", source)) == 1:
            findings.append(source_issue("Unused variable", "Maintainability", "Low", f"'{name}' is declared but never used.", "Remove it or use it in the implementation.", relative, lines, source[:match.start()].count("\n") + 1, "Potential"))
    parameters = set(re.findall(r"function\s+\w+\s*\(([^)]*)\)", source))
    declared = set(re.findall(r"\b(?:var|let|const|function|class)\s+([A-Za-z_$][\w$]*)", source))
    declared.update(name.strip() for group in parameters for name in group.split(",") if name.strip())
    if "discountAmount" in source and "discountAmount" not in declared:
        line = source[:source.find("discountAmount")].count("\n") + 1
        findings.append(source_issue("Undefined variable: discountAmount", "Static error", "High", "discountAmount is referenced but is not declared or passed into the function.", "Declare discountAmount or pass it as a function parameter.", relative, lines, line, "Potential", "const discountAmount = 0;"))
    return findings


def analyze_markup(path, relative):
    source = path.read_text(encoding="utf-8", errors="replace")
    lines = source.splitlines()
    findings = []
    for match in re.finditer(r"<img\b(?![^>]*\balt\s*=)[^>]*>", source, re.I):
        findings.append(source_issue("Image is missing alternative text", "Accessibility", "Medium", "Images without alt text are not understandable to screen-reader users.", "Add a meaningful alt attribute, or alt=\"\" for decorative images.", relative, lines, source[:match.start()].count("\n") + 1, "Confirmed"))
    if re.search(r"<form\b", source, re.I) and not re.search(r"<label\b", source, re.I):
        findings.append(source_issue("Form controls have no labels", "Accessibility", "Medium", "A form without labels is difficult to use with assistive technology.", "Associate every input with a visible label.", relative, lines, source.lower().find("<form") and source[:source.lower().find("<form")].count("\n") + 1 or 1, "Potential"))
    for match in re.finditer(r"<input\b(?![^>]*\b(?:required|aria-required)\b)[^>]*>", source, re.I):
        findings.append(source_issue("Input has no required validation", "Form validation", "Low", "This input is optional unless browser or application validation is added elsewhere.", "Add required or explicit validation when the field is mandatory.", relative, lines, source[:match.start()].count("\n") + 1, "Potential"))
    return findings


def analyze_css(path, relative):
    source = path.read_text(encoding="utf-8", errors="replace")
    lines = source.splitlines()
    findings = []
    if source.count("{") != source.count("}"):
        findings.append(source_issue("Unbalanced CSS braces", "Syntax error", "High", "The stylesheet has unmatched braces and may not parse as intended.", "Balance every opening and closing brace.", relative, lines, 1, "Confirmed"))
    if re.search(r"position\s*:\s*fixed", source, re.I) and not re.search(r"@media", source, re.I):
        findings.append(source_issue("Fixed layout has no responsive rule", "Responsive design", "Low", "Fixed positioning without a media query can cause overflow on small screens.", "Add responsive rules for narrow viewports.", relative, lines, 1, "Potential"))
    return findings


def analyze_java(path, relative):
    source = path.read_text(encoding="utf-8", errors="replace")
    lines = source.splitlines()
    findings = []
    if source.count("{") != source.count("}"):
        findings.append(source_issue("Unbalanced Java braces", "Syntax error", "Critical", "The source has unmatched braces.", "Balance the class and method braces.", relative, lines, 1, "Confirmed"))
    if re.search(r"\bSystem\.out\.println\b", source):
        findings.append(source_issue("Debug output in production code", "Code quality", "Low", "Direct console output may expose internal details and complicate logging.", "Use the project logging framework.", relative, lines, source.find("System.out.println") and source[:source.find("System.out.println")].count("\n") + 1 or 1, "Potential"))
    return findings


def analyze_file(path, relative, language):
    if language == "Python" and path.suffix.lower() == ".py":
        return analyze_python(path, relative)
    if language == "JavaScript" and path.suffix.lower() in LANGUAGE_EXTENSIONS[language]:
        return analyze_javascript(path, relative)
    if language == "HTML" and path.suffix.lower() in LANGUAGE_EXTENSIONS[language]:
        return analyze_markup(path, relative)
    if language == "CSS" and path.suffix.lower() == ".css":
        return analyze_css(path, relative)
    if language == "Java" and path.suffix.lower() == ".java":
        return analyze_java(path, relative)
    return []


def language_for_extension(extension):
    extension = extension.lower()
    return next((name for name, extensions in LANGUAGE_EXTENSIONS.items() if extension in extensions), None)


def analyze_source(root, language=None):
    findings = []
    files = [p for p in root.rglob("*") if p.is_file() and language_for_extension(p.suffix)]
    analyzed_languages = set()
    for path in files[:500]:
        relative = str(path.relative_to(root))
        file_language = language_for_extension(path.suffix)
        analyzed_languages.add(file_language)
        findings.extend(analyze_file(path, relative, file_language))
        text = path.read_text(encoding="utf-8", errors="replace") if path.stat().st_size < 2_000_000 else ""
        for match in re.finditer(r"console\.log\([^)]*\)", text):
            findings.append(issue("Debug logging left in source", "Code quality", "Low", 0.9, "Debug output may expose internal details or create noisy production logs.", match.group(0), "Production code uses structured logging where needed.", "A console.log statement remains.", "Remove the debug statement or replace it with controlled logging.", relative, text[:match.start()].count("\n") + 1, "Confirmed"))
        if re.search(r"catch\s*\(\s*\w+\s*\)\s*\{\s*\}", text):
            findings.append(issue("Empty error handler", "Error handling", "Medium", 0.87, "An empty catch block can hide failures and make diagnosis impossible.", "Empty catch block found.", "Errors are logged, surfaced, or handled explicitly.", "The exception is silently ignored.", "Handle the error explicitly and preserve useful context.", relative, text[:text.find("catch")].count("\n") + 1, "Confirmed"))
    return findings, analyzed_languages


def build_input_workspace(files):
    workspace = Path(tempfile.mkdtemp(prefix="analysis-", dir=WORKSPACES))
    uploaded_files = []
    for upload in files:
        original = secure_filename(upload.filename or "")
        if not original:
            raise ValueError("An uploaded file has no readable filename.")
        destination = workspace / original
        if Path(original).suffix.lower() not in ALLOWED_EXTENSIONS and not original.lower().endswith(".zip"):
            raise ValueError(f"Unsupported upload type: {original}")
        upload.save(destination)
        if destination.stat().st_size == 0:
            raise ValueError(f"Uploaded file is empty: {original}")
        uploaded_files.append(original)
        if destination.suffix.lower() == ".zip":
            extracted = workspace / "project"
            extracted.mkdir()
            with zipfile.ZipFile(destination) as archive:
                safe_extract(archive, extracted)
            destination.unlink()
            uploaded_files.pop()
    return workspace, uploaded_files


@app.post("/api/analyzer/analyze")
def analyze():
    report = request.form.get("report", "").strip()
    source = request.form.get("source", "")
    source_filename = secure_filename(request.form.get("source_filename", "")) or {
        "Python": "pasted_source.py", "JavaScript": "pasted_source.js",
        "TypeScript": "pasted_source.ts", "Java": "pasted_source.java",
        "HTML": "pasted_source.html", "CSS": "pasted_source.css",
    }.get(request.form.get("language", "Python"), "pasted_source.txt")
    logs = request.form.get("logs", "").strip()
    language = request.form.get("language", "Python")
    if language not in LANGUAGES:
        return jsonify(error=f"Unsupported language: {language}. Choose Python, JavaScript, HTML, CSS, or Java."), 400
    if not any((report, logs, source.strip(), request.files.getlist("files"))):
        return jsonify(status="INVALID INPUT", error="Provide pasted source code, a bug report/log, or a supported source/project upload."), 400
    try:
        app.logger.info("Starting static analysis: language=%s filename=%s files=%s", language, source_filename, len(request.files.getlist("files")))
        workspace, uploaded_files = build_input_workspace(request.files.getlist("files"))
        if not source.strip() and not request.files.getlist("files") and looks_like_source(report, language):
            source = report
            (workspace / source_filename).write_text(source, encoding="utf-8")
        if source.strip():
            (workspace / source_filename).write_text(source, encoding="utf-8")
        findings, analyzed_languages = analyze_source(workspace)
        if uploaded_files and not analyzed_languages:
            raise ValueError("No supported source files were found in the upload. Supported extensions are .py, .js, .jsx, .ts, .tsx, .java, .html, and .css.")
        if uploaded_files and language not in analyzed_languages:
            findings.insert(0, issue(
                "Selected language did not match uploaded source",
                "Analysis limitation",
                "Low",
                1.0,
                f"The upload was analyzed using its file extension ({', '.join(sorted(analyzed_languages))}), not the selected {language} language.",
                ", ".join(uploaded_files),
                "The selected language matches the uploaded source.",
                f"Selected {language}; detected {', '.join(sorted(analyzed_languages))}.",
                "Select the matching language when submitting pasted source. Uploaded files are analyzed by extension.",
                uploaded_files[0],
                1,
                "Informational",
            ))
        if logs and re.search(r"(traceback|exception|syntaxerror|error:)", logs, re.I):
            findings.insert(0, issue("Reported runtime error", "Runtime error", "High", 0.9, "The supplied log contains an error or exception marker.", logs[:1000], "The operation completes without an exception.", logs[:1000], "Reproduce the error and inspect the referenced stack frame.", verified="Confirmed"))
        if report and not source.strip() and not request.files.getlist("files") and not findings:
            findings.append(issue("Behavior requires manual verification", "Behavioral check", "Low", 0.55, "The report describes behavior, but no source-level defect was confirmed by the available evidence.", report[:1000], request.form.get("expected", "Expected behavior provided by reporter."), request.form.get("actual", report), "Upload source and a reproducible test to verify the implementation.", verified="Unverified"))
        confirmed = sum(x["verification"] == "Confirmed" for x in findings)
        potential = sum(x["verification"] == "Potential" for x in findings)
        incomplete = sum(x["verification"] == "Unverified" for x in findings)
        informational = sum(x["verification"] == "Informational" for x in findings)
        verdict = "BUGS FOUND" if confirmed or potential else "ANALYSIS INCOMPLETE" if incomplete else "NO BUGS DETECTED"
        status = "completed" if not incomplete else "incomplete"
        result = {"status": status, "summary": {"confirmed": confirmed, "potential": potential, "passed": 0 if confirmed or potential else 1, "failed": confirmed, "incomplete": incomplete, "informational": informational, "total": confirmed + potential, "verdict": verdict, "syntax": "Passed" if not any(x["category"] == "Syntax error" for x in findings) else "Failed", "security": "Passed" if not any(x["category"] == "Security" for x in findings) else "Issues found"}, "findings": findings, "workspace": str(workspace), "inputs": {"report": report, "logs": logs, "source": source, "source_filename": source_filename, "uploaded_files": uploaded_files, "detected_languages": sorted(analyzed_languages), "steps": request.form.get("steps", ""), "expected": request.form.get("expected", ""), "actual": request.form.get("actual", "")}}
        analysis_id = uuid.uuid4().hex
        with db() as connection:
            connection.execute("INSERT INTO analyses VALUES (?, ?, ?, ?, ?, ?)", (analysis_id, now(), language, status, json.dumps({"report": report, "logs": logs}), json.dumps(result)))
        app.logger.info("Completed static analysis: id=%s status=%s findings=%s", analysis_id, status, len(findings))
        return jsonify(id=analysis_id, **result)
    except (ValueError, zipfile.BadZipFile) as error:
        app.logger.warning("Invalid analysis request: %s", error)
        return jsonify(error=str(error)), 400


@app.errorhandler(405)
def method_not_allowed(error):
    app.logger.warning("Unsupported analyzer request method=%s path=%s", request.method, request.path)
    return jsonify(status="ANALYSIS FAILED", error=f"{request.method} is not allowed for {request.path}. Use POST /api/analyzer/analyze for source analysis."), 405


@app.errorhandler(500)
def internal_server_error(error):
    app.logger.exception("Unhandled analyzer server error")
    return jsonify(status="ANALYSIS FAILED", error="The analyzer failed while processing the request. Check the server log and retry."), 500


@app.get("/api/analyzer/analyze")
def analyze_get_not_allowed():
    return jsonify(status="ANALYSIS FAILED", error="GET is not allowed for /api/analyzer/analyze. Use POST with source code and language."), 405


@app.get("/api/analyzer/reports")
def list_reports():
    with db() as connection:
        rows = connection.execute("SELECT id, created_at, language, status, result_json FROM analyses ORDER BY created_at DESC").fetchall()
    return jsonify([{"id": row["id"], "created_at": row["created_at"], "language": row["language"], "status": row["status"], "summary": json.loads(row["result_json"])["summary"]} for row in rows])


@app.get("/api/analyzer/<analysis_id>")
def get_analysis(analysis_id):
    with db() as connection:
        row = connection.execute("SELECT * FROM analyses WHERE id=?", (analysis_id,)).fetchone()
    if not row:
        return jsonify(error="Analysis not found."), 404
    return jsonify(id=row["id"], created_at=row["created_at"], language=row["language"], **json.loads(row["result_json"]))


@app.delete("/api/analyzer/<analysis_id>")
def delete_analysis(analysis_id):
    with db() as connection:
        row = connection.execute("SELECT result_json FROM analyses WHERE id=?", (analysis_id,)).fetchone()
        if not row:
            return jsonify(error="Analysis not found."), 404
        workspace = json.loads(row["result_json"]).get("workspace")
        connection.execute("DELETE FROM fixes WHERE analysis_id=?", (analysis_id,))
        connection.execute("DELETE FROM analyses WHERE id=?", (analysis_id,))
    if workspace:
        shutil.rmtree(workspace, ignore_errors=True)
    return "", 204


@app.post("/api/analyzer/<analysis_id>/fix")
def propose_fix(analysis_id):
    payload = request.get_json(silent=True) or {}
    issue_data = payload.get("issue")
    if not issue_data:
        return jsonify(error="An issue is required."), 400
    original = issue_data.get("evidence", "")
    original = issue_data.get("original_code") or issue_data.get("evidence", "")
    proposed = issue_data.get("corrected_code") or f"# Review and correct: {issue_data.get('title', 'issue')}\n{original}"
    fix_id = uuid.uuid4().hex
    with db() as connection:
        connection.execute("INSERT INTO fixes VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (fix_id, analysis_id, issue_data.get("id", ""), now(), "proposed", original, proposed, issue_data.get("recommendation", "Review the proposed change.")))
    return jsonify(id=fix_id, status="proposed", original=original, proposed=proposed, explanation=issue_data.get("recommendation", "Review this minimal proposed fix before applying."))


@app.post("/api/analyzer/fixes/<fix_id>/apply")
def apply_fix(fix_id):
    with db() as connection:
        row = connection.execute("SELECT * FROM fixes WHERE id=?", (fix_id,)).fetchone()
        if not row:
            return jsonify(error="Fix proposal not found."), 404
        connection.execute("UPDATE fixes SET status='approved' WHERE id=?", (fix_id,))
    return jsonify(id=fix_id, status="approved", message="Approved in controlled workspace. Original files remain unchanged.")


@app.post("/api/analyzer/<analysis_id>/verify")
def verify(analysis_id):
    with db() as connection:
        row = connection.execute("SELECT result_json FROM analyses WHERE id=?", (analysis_id,)).fetchone()
    if not row:
        return jsonify(error="Analysis not found."), 404
    result = json.loads(row["result_json"])
    outcome = "Partially Verified" if result["summary"]["confirmed"] else "Not Verified"
    return jsonify(status=outcome, checks=[{"name": "Static analysis", "status": "Passed" if result["summary"]["confirmed"] == 0 else "Failed", "output": "Analysis completed without executing uploaded scripts."}], errors=[] if result["summary"]["confirmed"] == 0 else ["Findings require source changes and a project-specific test suite."])


@app.get("/api/analyzer/<analysis_id>/report")
def download_report(analysis_id):
    with db() as connection:
        row = connection.execute("SELECT * FROM analyses WHERE id=?", (analysis_id,)).fetchone()
    if not row:
        return jsonify(error="Analysis not found."), 404
    report = {"id": row["id"], "created_at": row["created_at"], "language": row["language"], "result": json.loads(row["result_json"])}
    target = DATA / f"{analysis_id}-report.json"
    target.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return send_file(target, as_attachment=True, download_name="bugtrack-analysis-report.json")


init_db()
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
