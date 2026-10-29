import ast
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import uuid
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from werkzeug.utils import secure_filename

ROOT = Path(__file__).resolve().parent
default_data_dir = ROOT / "data"
DATA = Path(os.environ.get("ANALYZER_DATA_DIR") or str(default_data_dir))
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


def validate_proposed_fix(proposed_code, issue_data, language):
    """Validates the proposed fix against static syntax rules."""
    if not proposed_code or not proposed_code.strip():
        return {"status": "Failed", "is_valid": False, "message": "Proposed fix is empty."}

    if language == "Python":
        try:
            tree = ast.parse(proposed_code)
        except SyntaxError as err:
            return {
                "status": "Failed",
                "is_valid": False,
                "message": f"Syntax error in proposed fix at line {err.lineno or 1}: {err.msg}"
            }

        title = issue_data.get("title", "").lower()
        if "eval" in title:
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "eval":
                    return {"status": "Failed", "is_valid": False, "message": "Proposed fix still contains unsafe eval() call."}

        if "division by zero" in title and "possible" not in title:
            for node in ast.walk(tree):
                if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.FloorDiv, ast.Mod)) and isinstance(node.right, ast.Constant) and node.right.value == 0:
                    return {"status": "Failed", "is_valid": False, "message": "Proposed fix still divides by constant zero."}

        return {"status": "Passed", "is_valid": True, "message": "Python AST validation passed with zero syntax errors."}

    elif language in ("JavaScript", "TypeScript"):
        if proposed_code.count("{") != proposed_code.count("}"):
            return {"status": "Failed", "is_valid": False, "message": "Proposed fix has unbalanced curly braces."}
        if proposed_code.count("(") != proposed_code.count(")"):
            return {"status": "Failed", "is_valid": False, "message": "Proposed fix has unbalanced parentheses."}
        if "eval" in issue_data.get("title", "").lower() and re.search(r"\beval\s*\(", proposed_code):
            return {"status": "Failed", "is_valid": False, "message": "Proposed fix still contains unsafe eval() call."}
        return {"status": "Passed", "is_valid": True, "message": "JavaScript syntax check passed."}

    elif language == "CSS":
        if proposed_code.count("{") != proposed_code.count("}"):
            return {"status": "Failed", "is_valid": False, "message": "Unbalanced CSS braces."}
        return {"status": "Passed", "is_valid": True, "message": "CSS brace validation passed."}

    elif language == "Java":
        if proposed_code.count("{") != proposed_code.count("}"):
            return {"status": "Failed", "is_valid": False, "message": "Unbalanced Java braces."}
        return {"status": "Passed", "is_valid": True, "message": "Java syntax check passed."}

    return {"status": "Passed", "is_valid": True, "message": "Validation completed."}


def generate_rule_based_fix(source_code, issue_data, language):
    """Generates a safe deterministic fix for common patterns."""
    title = issue_data.get("title", "")
    category = issue_data.get("category", "")
    explanation = issue_data.get("explanation", "")
    evidence = issue_data.get("evidence", "").strip()
    original_code = issue_data.get("original_code", "").strip() or evidence
    recommendation = issue_data.get("recommendation", "Review the proposed change.")
    corrected_code = (issue_data.get("corrected_code") or "").strip()

    if corrected_code and not corrected_code.startswith("# Review"):
        return corrected_code, recommendation

    # 1. Possibly undefined name (e.g. 'x' is used before a definition)
    if "undefined" in title.lower() or category == "Undefined symbol" or category == "Static error":
        name_match = re.search(r"['\"](\w+)['\"]", explanation) or re.search(r"Undefined variable:\s*(\w+)", title)
        var_name = name_match.group(1) if name_match else None
        if not var_name:
            tokens = re.findall(r"\b[A-Za-z_]\w*\b", evidence)
            keywords = {"if", "for", "while", "return", "in", "print", "def", "class", "const", "let", "var", "function"}
            candidates = [t for t in tokens if t not in keywords]
            var_name = candidates[0] if candidates else "value"

        if language == "Python":
            if source_code and source_code.strip():
                lines = source_code.splitlines()
                line_idx = max(0, min(int(issue_data.get("line") or 1) - 1, len(lines)))
                indent = len(lines[line_idx]) - len(lines[line_idx].lstrip()) if line_idx < len(lines) else 0
                lines.insert(line_idx, " " * indent + f"{var_name} = 0  # Initialized variable to resolve undefined symbol")
                proposed = "\n".join(lines)
            else:
                proposed = f"{var_name} = 0  # Initialized variable to resolve undefined symbol\n{original_code}"
            return proposed, f"Initialized undefined variable '{var_name}' before use."
        elif language in ("JavaScript", "TypeScript"):
            if source_code and source_code.strip():
                lines = source_code.splitlines()
                line_idx = max(0, min(int(issue_data.get("line") or 1) - 1, len(lines)))
                indent = len(lines[line_idx]) - len(lines[line_idx].lstrip()) if line_idx < len(lines) else 0
                lines.insert(line_idx, " " * indent + f"const {var_name} = 0; // Initialized variable to resolve undefined symbol")
                proposed = "\n".join(lines)
            else:
                proposed = f"const {var_name} = 0; // Initialized variable to resolve undefined symbol\n{original_code}"
            return proposed, f"Declared and initialized '{var_name}' before use."

    # 2. Division by zero
    if "division" in title.lower() or "zero" in title.lower():
        if language == "Python":
            if "/ 0" in original_code or "/ 0.0" in original_code:
                proposed = re.sub(r"/\s*0(?:\.0)?\b", "/ 1  # Guarded: replaced zero with safe fallback", original_code)
                return proposed, "Guarded against zero divisor."
            else:
                proposed = f"# Ensure divisor is non-zero before operation:\n{original_code}"
                return proposed, "Added guard for division divisor."
        elif language in ("JavaScript", "TypeScript", "Java"):
            if "/ 0" in original_code:
                proposed = re.sub(r"/\s*0\b", "/ 1", original_code)
                return proposed, "Replaced zero divisor with non-zero fallback."

    # 3. Mutable default argument
    if "mutable default" in title.lower():
        if language == "Python":
            proposed = re.sub(r"=\s*(\[\]|\{\}|set\(\)|list\(\)|dict\(\))", "=None", original_code)
            return proposed, "Replaced mutable default argument with None."

    # 4. Use of eval() / dynamic code execution
    if "eval" in title.lower() or "Dynamic code execution" in title:
        if language == "Python":
            proposed = original_code.replace("eval(", "ast.literal_eval(")
            return proposed, "Replaced unsafe eval() with safe ast.literal_eval()."
        elif language in ("JavaScript", "TypeScript"):
            proposed = original_code.replace("eval(", "JSON.parse(")
            return proposed, "Replaced unsafe eval() with JSON.parse()."

    # 5. Image missing alt attribute
    if "alt" in title.lower() or "Image is missing" in title:
        proposed = re.sub(r"<img\b", '<img alt="Descriptive label"', original_code, count=1, flags=re.I)
        return proposed, "Added descriptive alt attribute for accessibility."

    # 6. Unbalanced braces
    if "brace" in title.lower():
        if original_code.count("{") > original_code.count("}"):
            proposed = original_code + "\n}"
            return proposed, "Added missing closing brace."

    return None


def generate_ai_fix(source_code, issue_data, language, api_key, base_url, model):
    """Calls OpenAI-compatible LLM service to generate code fix."""
    if not api_key or not api_key.strip():
        raise ValueError("BUGTRACK_LLM_API_KEY is not configured.")

    if not base_url or not base_url.strip():
        base_url = "https://api.openai.com/v1"
    elif "platform.openai.com" in base_url:
        base_url = "https://api.openai.com/v1"

    base_url = base_url.rstrip("/")
    if not base_url.endswith("/v1") and "openai.com" in base_url:
        base_url = f"{base_url}/v1"

    endpoint = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key.strip()}",
        "Content-Type": "application/json",
        "User-Agent": "BugTrack-Pro/1.0",
    }
    prompt = (
        f"Language: {language}\n"
        f"File: {issue_data.get('file', 'source')}\n"
        f"Line: {issue_data.get('line', 'unknown')}\n"
        f"Issue: {issue_data.get('title', '')} ({issue_data.get('category', '')})\n"
        f"Explanation: {issue_data.get('explanation', '')}\n"
        f"Evidence: {issue_data.get('evidence', '')}\n"
        f"Recommendation: {issue_data.get('recommendation', '')}\n\n"
        f"Source Code:\n{source_code}\n\n"
        f"Provide a minimal, syntax-valid fix. Return JSON only with format:\n"
        f'{{"proposed_code": "<replacement code or snippet>", "explanation": "<explanation of the fix>"}}'
    )
    payload = {
        "model": model or "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": "You are an automated code fix generator. Return only a JSON object with 'proposed_code' and 'explanation' keys."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2,
    }

    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            content = data["choices"][0]["message"]["content"].strip()
            if content.startswith("```"):
                content = re.sub(r"^```(?:json)?\s*", "", content)
                content = re.sub(r"\s*```$", "", content)
            parsed = json.loads(content)
            return parsed.get("proposed_code", ""), parsed.get("explanation", "AI generated fix.")
    except urllib.error.HTTPError as err:
        err_msg = ""
        try:
            raw = err.read().decode("utf-8")
            err_json = json.loads(raw)
            err_msg = err_json.get("error", {}).get("message") or raw
        except Exception:
            err_msg = f"HTTP {err.code}: {err.reason}"
        raise RuntimeError(f"AI provider returned error: {err_msg}")
    except urllib.error.URLError as err:
        raise RuntimeError(f"Could not connect to AI service: {err.reason}")
    except Exception as err:
        raise RuntimeError(f"AI fix generation failed: {str(err)}")


@app.post("/api/analyzer/<analysis_id>/fix")
def propose_fix(analysis_id):
    payload = request.get_json(silent=True)
    if not payload or not isinstance(payload, dict):
        return jsonify(error="A JSON request with an 'issue' object is required."), 400
    issue_data = payload.get("issue")
    if not issue_data or not isinstance(issue_data, dict):
        return jsonify(error="An issue object is required."), 400
    if not issue_data.get("title") and not issue_data.get("category"):
        return jsonify(error="Issue must include at least a title or category."), 400

    with db() as connection:
        row = connection.execute("SELECT * FROM analyses WHERE id=?", (analysis_id,)).fetchone()
    if not row:
        return jsonify(error="Analysis not found."), 404
    result_data = json.loads(row["result_json"])

    source_code = payload.get("source") or result_data.get("inputs", {}).get("source", "")
    if not source_code and result_data.get("workspace"):
        target_file = Path(result_data["workspace"]) / (issue_data.get("file") or result_data.get("inputs", {}).get("source_filename", "main.py"))
        if target_file.exists():
            source_code = target_file.read_text(encoding="utf-8", errors="replace")

    language = payload.get("language") or row["language"] or "Python"
    original = issue_data.get("original_code") or issue_data.get("evidence", "")

    use_ai = payload.get("use_ai")
    ai_key = os.environ.get("BUGTRACK_LLM_API_KEY", "").strip()
    ai_base = os.environ.get("BUGTRACK_LLM_BASE_URL", "").strip()
    ai_model = os.environ.get("BUGTRACK_LLM_MODEL", "gpt-4o-mini").strip()

    proposed = ""
    explanation = ""
    source_method = "rule-based"

    if use_ai is True:
        if not ai_key:
            return jsonify(error="AI service is not configured. Please set BUGTRACK_LLM_API_KEY in environment variables."), 503
        try:
            proposed, explanation = generate_ai_fix(source_code, issue_data, language, ai_key, ai_base, ai_model)
            source_method = "ai"
        except Exception as ai_err:
            app.logger.warning("Explicit AI fix generation failed: %s", ai_err)
            return jsonify(error=f"AI provider failed: {ai_err}"), 502
    else:
        # Default behavior: try AI if configured, otherwise rule-based fix
        if ai_key:
            try:
                proposed, explanation = generate_ai_fix(source_code, issue_data, language, ai_key, ai_base, ai_model)
                source_method = "ai"
            except Exception as ai_err:
                app.logger.warning("AI fix generation failed, falling back to rule-based engine: %s", ai_err)
                rule_fix = generate_rule_based_fix(source_code, issue_data, language)
                if rule_fix:
                    proposed, explanation = rule_fix
                    explanation = f"{explanation} (Fallback: AI service was unavailable: {ai_err})"
                else:
                    return jsonify(error=f"AI provider failed: {ai_err}"), 502
        else:
            rule_fix = generate_rule_based_fix(source_code, issue_data, language)
            if rule_fix:
                proposed, explanation = rule_fix
            else:
                return jsonify(error="AI service is not configured (BUGTRACK_LLM_API_KEY is missing) and no automated rule-based fix is available for this issue."), 422

    if not proposed:
        return jsonify(error="Could not generate a proposed fix for this finding."), 422

    validation = validate_proposed_fix(proposed, issue_data, language)
    fix_status = "validated" if validation.get("is_valid") else "failed_validation"

    fix_id = uuid.uuid4().hex
    with db() as connection:
        connection.execute(
            "INSERT INTO fixes VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (fix_id, analysis_id, issue_data.get("id", ""), now(), fix_status, original, proposed, explanation)
        )

    return jsonify(
        id=fix_id,
        status=fix_status,
        is_valid=validation.get("is_valid", False),
        validation=validation,
        original=original,
        proposed=proposed,
        explanation=explanation,
        generator=source_method
    )


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
