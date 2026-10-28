import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from app import app


def test_python_syntax_error_is_confirmed():
    client = app.test_client()
    response = client.post("/api/analyzer/analyze", data={"language": "Python", "files": (io.BytesIO(b"def broken(:\n"), "broken.py")}, content_type="multipart/form-data")
    body = response.get_json()
    assert response.status_code == 200
    assert body["summary"]["confirmed"] == 1
    assert body["findings"][0]["category"] == "Syntax error"


def test_report_without_source_is_unverified():
    client = app.test_client()
    response = client.post("/api/analyzer/analyze", data={"report": "Login does not respond", "expected": "Dashboard opens", "actual": "Nothing happens"}, content_type="multipart/form-data")
    body = response.get_json()
    assert body["summary"]["incomplete"] == 1
    assert body["findings"][0]["verification"] == "Unverified"


def test_pasted_python_code_is_analyzed_as_source():
    code = "def add_to_cart(item, cart=[]):\n    cart.append(item)\n    return cart\n"
    response = app.test_client().post(
        "/api/analyzer/analyze",
        data={"language": "Python", "report": code},
        content_type="multipart/form-data",
    )
    body = response.get_json()
    assert response.status_code == 200
    assert body["summary"]["verdict"] == "BUGS FOUND"
    assert body["findings"][0]["title"] == "Mutable default argument"


def test_clean_pasted_python_code_reports_no_bug():
    response = app.test_client().post(
        "/api/analyzer/analyze",
        data={"language": "Python", "report": "def add(item, cart=None):\n    if cart is None:\n        cart = []\n    cart.append(item)\n    return cart\n"},
        content_type="multipart/form-data",
    )
    body = response.get_json()
    assert response.status_code == 200
    assert body["summary"]["verdict"] == "NO BUGS DETECTED"


def analyze_code(code, language):
    return app.test_client().post(
        "/api/analyzer/analyze",
        data={"language": language, "report": code},
        content_type="multipart/form-data",
    ).get_json()


def test_python_static_checks_find_undefined_and_division_risks():
    body = analyze_code("def divide(a, b):\n    return a / b\nprint(missing_value)\n", "Python")
    titles = {item["title"] for item in body["findings"]}
    assert body["summary"]["verdict"] == "BUGS FOUND"
    assert "Possibly undefined name" in titles
    assert "Possible division by zero" in titles


def test_javascript_security_check_does_not_execute_code():
    body = analyze_code("const value = eval(inputValue);\n", "JavaScript")
    assert body["summary"]["verdict"] == "BUGS FOUND"
    assert any(item["category"] == "Security" for item in body["findings"])


def test_html_and_css_checks_report_accessibility_and_syntax():
    html = analyze_code("<form><input type='email'></form><img src='x.png'>", "HTML")
    css = analyze_code(".card { color: red;", "CSS")
    assert any(item["category"] == "Accessibility" for item in html["findings"])
    assert css["summary"]["verdict"] == "BUGS FOUND"
    assert any(item["category"] == "Syntax error" for item in css["findings"])


def test_unsupported_language_is_rejected():
    response = app.test_client().post(
        "/api/analyzer/analyze",
        data={"language": "Ruby", "report": "puts 'hello'"},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    assert "Unsupported language" in response.get_json()["error"]


def test_analyze_route_accepts_post_and_rejects_get_with_json_error():
    client = app.test_client()
    response = client.post(
        "/api/analyzer/analyze",
        data={"source": "def ok():\n    return 1\n", "source_filename": "main.py", "language": "Python"},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    assert response.is_json
    method_response = client.get("/api/analyzer/analyze")
    assert method_response.status_code == 405
    assert method_response.is_json
    assert "Use POST" in method_response.get_json()["error"]


def test_empty_analysis_input_is_rejected():
    response = app.test_client().post(
        "/api/analyzer/analyze",
        data={"language": "Python"},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    assert response.get_json()["status"] == "INVALID INPUT"


def test_report_is_retained_and_can_be_explicitly_deleted():
    client = app.test_client()
    response = client.post("/api/analyzer/analyze", data={"report": "Login does not respond"}, content_type="multipart/form-data")
    analysis_id = response.get_json()["id"]
    assert any(item["id"] == analysis_id for item in client.get("/api/analyzer/reports").get_json())
    assert client.delete(f"/api/analyzer/{analysis_id}").status_code == 204
    assert client.get(f"/api/analyzer/{analysis_id}").status_code == 404


def test_unsafe_zip_path_is_rejected():
    import zipfile
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr("../escape.py", "print('bad')")
    archive.seek(0)
    response = client = app.test_client().post(
        "/api/analyzer/analyze",
        data={"files": (archive, "project.zip")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    assert "unsafe path" in response.get_json()["error"].lower()


def test_pasted_valid_python_is_analyzed_without_file():
    client = app.test_client()
    response = client.post("/api/analyzer/analyze", data={
        "source": "def add(a, b):\n    return a + b\n\nprint(add(2, 3))",
        "source_filename": "main.py",
        "language": "Python",
    }, content_type="multipart/form-data")
    body = response.get_json()
    assert response.status_code == 200
    assert body["summary"]["verdict"] == "NO BUGS DETECTED"
    assert body["inputs"]["source"].startswith("def add")


def test_pasted_python_syntax_error_and_division_risk():
    client = app.test_client()
    syntax = client.post("/api/analyzer/analyze", data={"source": "def add(a, b)\n    return a + b", "language": "Python"}, content_type="multipart/form-data").get_json()
    division = client.post("/api/analyzer/analyze", data={"source": "def divide(a, b):\n    return a / 0", "language": "Python"}, content_type="multipart/form-data").get_json()
    assert syntax["summary"]["confirmed"] >= 1
    assert any("syntax" in finding["title"].lower() for finding in syntax["findings"])
    assert any("division" in finding["title"].lower() for finding in division["findings"])


def test_pasted_javascript_undefined_variable():
    client = app.test_client()
    response = client.post("/api/analyzer/analyze", data={"source": "function calculateTotal(price) {\n    return price + discountAmount;\n}", "language": "JavaScript", "source_filename": "app.js"}, content_type="multipart/form-data")
    body = response.get_json()
    assert any("discountAmount" in finding["title"] for finding in body["findings"])


def test_uploaded_javascript_uses_file_extension_and_detects_syntax_error():
    response = app.test_client().post(
        "/api/analyzer/analyze",
        data={"language": "Python", "files": (io.BytesIO(b"function broken( {\n"), "app.js")},
        content_type="multipart/form-data",
    )
    body = response.get_json()
    assert response.status_code == 200
    assert body["summary"]["verdict"] == "BUGS FOUND"
    assert any(item["title"] == "JavaScript syntax error" and item["file"] == "app.js" for item in body["findings"])
    assert body["inputs"]["detected_languages"] == ["JavaScript"]


def test_uploaded_python_syntax_error_is_detected():
    response = app.test_client().post(
        "/api/analyzer/analyze",
        data={"language": "JavaScript", "files": (io.BytesIO(b"def broken(:\n"), "app.py")},
        content_type="multipart/form-data",
    )
    body = response.get_json()
    assert response.status_code == 200
    assert any(item["category"] == "Syntax error" and item["file"] == "app.py" for item in body["findings"])


def test_uploaded_valid_javascript_completes_without_fabricated_findings():
    response = app.test_client().post(
        "/api/analyzer/analyze",
        data={"files": (io.BytesIO(b"function add(a, b) { return a + b; }\n"), "app.js")},
        content_type="multipart/form-data",
    )
    body = response.get_json()
    assert response.status_code == 200
    assert body["status"] == "completed"
    assert body["summary"]["verdict"] == "NO BUGS DETECTED"
    assert body["summary"]["total"] == 0


def test_empty_and_unsupported_uploads_are_rejected():
    client = app.test_client()
    empty = client.post(
        "/api/analyzer/analyze",
        data={"files": (io.BytesIO(b""), "empty.js")},
        content_type="multipart/form-data",
    )
    unsupported = client.post(
        "/api/analyzer/analyze",
        data={"files": (io.BytesIO(b"puts 'hello'"), "app.rb")},
        content_type="multipart/form-data",
    )
    assert empty.status_code == 400
    assert "empty" in empty.get_json()["error"].lower()
    assert unsupported.status_code == 400
    assert "unsupported" in unsupported.get_json()["error"].lower()


# --- Step 10: Generate Fix & Validation Workflow Tests ---

def test_valid_source_code():
    """1. Test that valid source code is parsed cleanly and reports no syntax bugs."""
    client = app.test_client()
    resp = client.post("/api/analyzer/analyze", data={
        "source": "def calculate_total(price, tax):\n    return price + (price * tax)\n",
        "source_filename": "calc.py",
        "language": "Python"
    }, content_type="multipart/form-data")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["status"] == "completed"
    assert body["summary"]["verdict"] == "NO BUGS DETECTED"
    assert not any(f["category"] == "Syntax error" for f in body["findings"])


def test_source_code_containing_syntax_error():
    """2. Test that source code with a syntax error is detected and confirmed."""
    client = app.test_client()
    resp = client.post("/api/analyzer/analyze", data={
        "source": "def broken_func(:\n    pass\n",
        "source_filename": "broken.py",
        "language": "Python"
    }, content_type="multipart/form-data")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["summary"]["verdict"] == "BUGS FOUND"
    assert body["summary"]["confirmed"] >= 1
    syntax_issues = [f for f in body["findings"] if f["category"] == "Syntax error"]
    assert len(syntax_issues) >= 1
    assert syntax_issues[0]["verification"] == "Confirmed"


def test_empty_source_code():
    """3. Test that empty source code input is rejected with 400 and clear error."""
    client = app.test_client()
    resp = client.post("/api/analyzer/analyze", data={
        "source": "   ",
        "report": "",
        "logs": "",
        "language": "Python"
    }, content_type="multipart/form-data")
    assert resp.status_code == 400
    body = resp.get_json()
    assert body["status"] == "INVALID INPUT"
    assert "Provide pasted source code" in body["error"]


def test_missing_required_request_fields():
    """4. Test that missing required request fields in fix generation return 400."""
    client = app.test_client()
    # Create an analysis first
    an_res = client.post("/api/analyzer/analyze", data={
        "source": "x = 1 / 0\n",
        "language": "Python"
    }, content_type="multipart/form-data")
    analysis_id = an_res.get_json()["id"]

    # 4a: Missing whole JSON body
    empty_fix = client.post(f"/api/analyzer/{analysis_id}/fix", json={})
    assert empty_fix.status_code == 400
    assert "required" in empty_fix.get_json()["error"].lower()

    # 4b: Missing 'issue' field
    no_issue_fix = client.post(f"/api/analyzer/{analysis_id}/fix", json={"other": "data"})
    assert no_issue_fix.status_code == 400
    assert "issue object is required" in no_issue_fix.get_json()["error"].lower()

    # 4c: Issue object missing both title and category
    bad_issue_fix = client.post(f"/api/analyzer/{analysis_id}/fix", json={"issue": {"evidence": "abc"}})
    assert bad_issue_fix.status_code == 400
    assert "title or category" in bad_issue_fix.get_json()["error"].lower()


def test_missing_or_invalid_ai_configuration(monkeypatch):
    """5. Test that missing or invalid AI configuration returns clear 503 error."""
    client = app.test_client()
    an_res = client.post("/api/analyzer/analyze", data={
        "source": "if x > 5:\n    print(x)\n",
        "language": "Python"
    }, content_type="multipart/form-data")
    analysis_id = an_res.get_json()["id"]
    finding = an_res.get_json()["findings"][0]

    # Explicitly clear BUGTRACK_LLM_API_KEY
    monkeypatch.setenv("BUGTRACK_LLM_API_KEY", "")

    # Request fix with use_ai=True
    resp = client.post(f"/api/analyzer/{analysis_id}/fix", json={
        "issue": finding,
        "use_ai": True
    })
    assert resp.status_code == 503
    body = resp.get_json()
    assert "BUGTRACK_LLM_API_KEY" in body["error"]


def test_ai_provider_failures(monkeypatch):
    """6. Test that AI provider failure returns a safe, clear 502 error message."""
    client = app.test_client()
    an_res = client.post("/api/analyzer/analyze", data={
        "source": "if x > 5:\n    print(x)\n",
        "language": "Python"
    }, content_type="multipart/form-data")
    analysis_id = an_res.get_json()["id"]
    finding = an_res.get_json()["findings"][0]

    monkeypatch.setenv("BUGTRACK_LLM_API_KEY", "test-key-12345")
    monkeypatch.setenv("BUGTRACK_LLM_BASE_URL", "https://api.openai.com/v1")

    # Mock urllib.request.urlopen to simulate provider connection failure
    import urllib.error
    def mock_urlopen(req, timeout=15):
        raise urllib.error.URLError("Connection refused by upstream AI service")

    monkeypatch.setattr("urllib.request.urlopen", mock_urlopen)

    resp = client.post(f"/api/analyzer/{analysis_id}/fix", json={
        "issue": finding,
        "use_ai": True
    })
    assert resp.status_code == 502
    body = resp.get_json()
    assert "AI provider failed" in body["error"]
    assert "Connection refused" in body["error"]
    # Verify API key is NOT leaked in the error message
    assert "test-key-12345" not in body["error"]


def test_successful_fix_generation():
    """7. Test successful fix generation and verification for undefined symbol."""
    client = app.test_client()
    an_res = client.post("/api/analyzer/analyze", data={
        "source": "if x > 5:\n    print(x)\n",
        "source_filename": "main.py",
        "language": "Python"
    }, content_type="multipart/form-data")
    analysis_id = an_res.get_json()["id"]
    finding = an_res.get_json()["findings"][0]

    resp = client.post(f"/api/analyzer/{analysis_id}/fix", json={
        "issue": finding
    })
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["status"] == "validated"
    assert body["is_valid"] is True
    assert body["validation"]["status"] == "Passed"
    assert "x = 0" in body["proposed"]
    assert "print(x)" in body["proposed"]


def test_failed_fix_validation():
    """8. Test that a proposed fix containing syntax errors fails validation."""
    from app import validate_proposed_fix
    
    broken_fix = "def broken(\n    return 123\n"
    issue = {"title": "Sample syntax issue", "category": "Syntax error"}
    val_result = validate_proposed_fix(broken_fix, issue, "Python")
    assert val_result["is_valid"] is False
    assert val_result["status"] == "Failed"
    assert "Syntax error" in val_result["message"]

    eval_issue = {"title": "Use of eval()", "category": "Security"}
    still_broken_eval = "x = eval(input())\n"
    eval_val = validate_proposed_fix(still_broken_eval, eval_issue, "Python")
    assert eval_val["is_valid"] is False
    assert "still contains unsafe eval" in eval_val["message"]
