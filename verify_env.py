# verify_env.py
"""
Kredibble Local Environment Verification Engine
Scans client machine for OS, Python dependencies, and WebGPU hardware profile.
"""
import sys
import platform
import shutil

# Ensure utf-8 output encoding for Windows terminal safety
if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

def check_system_architecture():
    print("=== [1/3] System Environment Profile ===")
    print(f"OS Platform: {platform.system()} {platform.release()}")
    print(f"Python Version: {platform.python_version()}")
    print(f"Processor: {platform.processor()}")
    if platform.system() not in ["Windows", "Darwin", "Linux"]:
        print("[!] Warning: Platform architecture outside standard enterprise matrix.")
    else:
        print("[OK] Core OS compatibility verified.")

def check_python_dependencies():
    print("\n=== [2/3] Python Dependency Registry Verification ===")
    required_packages = ["fastapi", "uvicorn", "pydantic_settings", "pypdf", "jwt", "email_validator", "pytest", "httpx"]
    missing_packages = []
    for pkg in required_packages:
        try:
            __import__(pkg)
            print(f"[OK] Package '{pkg}' is installed and accessible.")
        except ImportError:
            missing_packages.append(pkg)
            print(f"[X] Missing Package: '{pkg}' is not installed in this environment.")
    
    if missing_packages:
        print("\nResolution: Run 'pip install -r backend/requirements-dev.txt'")
        return False
    return True

def check_node_toolchain():
    print("\n=== Web Client Build Toolchain ===")
    for tool in ("node", "npm"):
        if shutil.which(tool):
            print(f"[OK] '{tool}' found.")
        else:
            print(f"[X] '{tool}' not found. Install Node.js 20+ to build the web client.")
            return False
    return True

def verify_browser_and_hardware_profile():
    print("\n=== [3/3] Client Interface Acceleration Profile ===")
    browsers = ["google-chrome", "chrome", "microsoft-edge", "edge", "brave"]
    found_browsers = []
    for browser in browsers:
        if shutil.which(browser) is not None:
            found_browsers.append(browser)
    
    if found_browsers:
        print(f"[OK] Detected accessible Chromium binaries: {', '.join(found_browsers)}")
        print("Hardware Target: Ensure 'Use graphics acceleration when available' is checked in browser settings.")
    else:
        print("[i] No Chromium binary on PATH. Use Chrome/Edge 121+ with WebGPU enabled.")

if __name__ == "__main__":
    print("======================================================================")
    print("KREDDIBLE PLATFORM: LOCAL INITIALIZATION AUDIT ENGINE")
    print("======================================================================\n")
    check_system_architecture()
    dependencies_ok = check_python_dependencies()
    dependencies_ok = check_node_toolchain() and dependencies_ok
    verify_browser_and_hardware_profile()
    print("\n======================================================================")
    if dependencies_ok:
        print("Status: Local environment verification checks completed successfully.")
    else:
        print("Status: Configuration steps required before running local execution cycles.")
    print("======================================================================")
