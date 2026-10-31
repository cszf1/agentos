# GUI half of the Shell: models, Qt Quick renderer items, the controller, fixed QML in qrc, the agentos-shell binary.
set(AGENTOS_QML
  qml/Main.qml qml/ShellRoot.qml qml/HealthCanvas.qml qml/Blocked.qml qml/PText.qml qml/FocusRing.qml qml/AButton.qml
  qml/ACheck.qml qml/AField.qml qml/AArea.qml qml/ASelect.qml qml/ATab.qml qml/SlotChild.qml qml/SlotNode.qml
  qml/SlotCanvas.qml qml/RecordsView.qml qml/TrustedConfirm.qml qml/ActionsList.qml qml/PageFrame.qml qml/HomePage.qml
  qml/LoginPage.qml qml/WorkspacesPage.qml qml/AppDetailPage.qml qml/TaskCenterPage.qml qml/PoliciesPage.qml
  qml/IncidentsPage.qml qml/ProposalsPage.qml qml/DiagnosticsPage.qml qml/BackupPage.qml qml/UpdatePage.qml
  qml/HardwarePage.qml)

add_library(agentos_ui STATIC
  models/json_list_model.cpp models/json_list_model.hpp
  models/slot_models.cpp models/slot_models.hpp
  models/canvas_model.cpp models/canvas_model.hpp
  renderer/app_view.cpp renderer/app_view.hpp renderer/request_sink.hpp
  renderer/chart_item.cpp renderer/chart_item.hpp
  app/shell_controller.cpp app/shell_controller.hpp
  app/qml_guard.cpp app/qml_guard.hpp
  app/ime_guard.cpp app/ime_guard.hpp
  app/health_canvas.cpp app/health_canvas.hpp)
target_include_directories(agentos_ui PUBLIC models renderer app)
target_link_libraries(agentos_ui PUBLIC agentos_core Qt6::Gui Qt6::Qml Qt6::Quick Qt6::QuickControls2)
qt_add_resources(agentos_ui "shell_qml" PREFIX "/agentos/qml" BASE qml FILES ${AGENTOS_QML})

add_executable(agentos-shell app/main.cpp)
target_link_libraries(agentos-shell PRIVATE agentos_ui)
if(TARGET Qt6::WaylandClient)
  target_link_libraries(agentos-shell PRIVATE Qt6::WaylandClient)
endif()
install(TARGETS agentos-shell RUNTIME DESTINATION bin)

set(AGENTOS_TEST_OUT "${CMAKE_CURRENT_SOURCE_DIR}/tests/out")
file(MAKE_DIRECTORY ${AGENTOS_TEST_OUT})
foreach(t gui_test flows_test)
  if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tests/${t}.cpp)
    add_executable(${t} tests/${t}.cpp tests/fake_gateway.hpp tests/gui_support.hpp)
    target_include_directories(${t} PRIVATE tests)
    target_link_libraries(${t} PRIVATE agentos_ui Qt6::Test)
    target_compile_definitions(${t} PRIVATE AGENTOS_FIXTURES="${AGENTOS_FIXTURES_ABS}" AGENTOS_TEST_OUT="${AGENTOS_TEST_OUT}")
    add_test(NAME ${t} COMMAND ${t})
    set_tests_properties(${t} PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_QUICK_BACKEND=software" TIMEOUT 300)
  endif()
endforeach()

add_test(NAME health_canvas COMMAND agentos-shell --health-canvas)
set_tests_properties(health_canvas PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_QUICK_BACKEND=software;AGENTOS_GATEWAY_SOCKET=/nonexistent/none.sock"
  PASS_REGULAR_EXPRESSION "\"ok\":true,\"frame\":true,\"input\":true" TIMEOUT 60)
add_test(NAME first_frame_within_5s COMMAND agentos-shell --first-frame-probe)
set_tests_properties(first_frame_within_5s PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_QUICK_BACKEND=software;AGENTOS_GATEWAY_SOCKET=/nonexistent/none.sock;HOME=${CMAKE_CURRENT_BINARY_DIR}"
  PASS_REGULAR_EXPRESSION "firstFrameMs" TIMEOUT 60)
add_test(NAME no_webengine COMMAND ${CMAKE_COMMAND} -DBIN=$<TARGET_FILE:agentos-shell> -DCACHE=${CMAKE_BINARY_DIR}/CMakeCache.txt -P ${CMAKE_CURRENT_SOURCE_DIR}/tests/no_webengine.cmake)

# VM-check-only driver (spec §32 D08/M06/O03 in m13-native): the same controller and QML against a REAL gateway.
# Never built for a release (off by default; os/packages builds it as a separate test-only derivation).
option(AGENTOS_E2E "build agentos-shell-e2e (VM checks only)" OFF)
if(AGENTOS_E2E)
  add_executable(agentos-shell-e2e tests/e2e_test.cpp tests/gui_support.hpp tests/e2e_sway.hpp tests/e2e_sway_phase.inc)
  target_include_directories(agentos-shell-e2e PRIVATE tests)
  target_link_libraries(agentos-shell-e2e PRIVATE agentos_ui Qt6::Test)
  target_compile_definitions(agentos-shell-e2e PRIVATE AGENTOS_FIXTURES="${AGENTOS_FIXTURES_ABS}" AGENTOS_TEST_OUT="/tmp/agentos-e2e")
  install(TARGETS agentos-shell-e2e RUNTIME DESTINATION bin)
endif()
