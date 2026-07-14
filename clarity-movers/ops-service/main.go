// ops-service owns CLARITY's core differentiator: no move clocks in until
// its full equipment checklist is confirmed on site. Movers and bookings
// are persisted by booking-service; this service enforces the workflow
// rules on top of that data.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

var bookingBaseURL = envOr("BOOKING_SERVICE_URL", "http://booking-service:4001")

var httpClient = &http.Client{Timeout: 5 * time.Second}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

type apiError struct {
	Status int
	Body   string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("upstream error %d: %s", e.Status, e.Body)
}

func bookingRequest(method, path, tenantID string, payload interface{}) ([]byte, error) {
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, bookingBaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("x-clarity-tenant-id", tenantID)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, &apiError{Status: resp.StatusCode, Body: string(respBody)}
	}
	return respBody, nil
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func tenantID(r *http.Request) (string, bool) {
	t := r.Header.Get("x-clarity-tenant-id")
	return t, t != ""
}

// --- Assignment ---------------------------------------------------------

type assignRequest struct {
	MoverID string `json:"mover_id"`
}

func handleAssign(w http.ResponseWriter, r *http.Request, moveID string) {
	tenant, ok := tenantID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "x-clarity-tenant-id header is required")
		return
	}
	var req assignRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MoverID == "" {
		writeError(w, http.StatusBadRequest, "mover_id is required")
		return
	}

	if _, err := bookingRequest("POST", "/moves/"+moveID+"/assignments", tenant, req); err != nil {
		forwardError(w, err)
		return
	}

	// First successful assignment moves the job out of "booked".
	statusUpdate := map[string]string{"status": "assigned"}
	if _, err := bookingRequest("PATCH", "/moves/"+moveID+"/status", tenant, statusUpdate); err != nil {
		forwardError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"move_id": moveID, "mover_id": req.MoverID, "status": "assigned"})
}

// --- Equipment checklist gate -------------------------------------------

type checklistConfirmRequest struct {
	MoverID string `json:"mover_id"`
}

type checklistItem struct {
	ID        string  `json:"id"`
	MoveID    string  `json:"move_id"`
	Item      string  `json:"item"`
	Confirmed bool    `json:"confirmed"`
}

func handleChecklistConfirm(w http.ResponseWriter, r *http.Request, moveID, item string) {
	tenant, ok := tenantID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "x-clarity-tenant-id header is required")
		return
	}
	var req checklistConfirmRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MoverID == "" {
		writeError(w, http.StatusBadRequest, "mover_id is required")
		return
	}

	confirmedBy := map[string]string{"confirmed_by": req.MoverID}
	if _, err := bookingRequest("PATCH", "/moves/"+moveID+"/checklist/"+item, tenant, confirmedBy); err != nil {
		forwardError(w, err)
		return
	}

	allConfirmed, checklist, err := checklistComplete(moveID, tenant)
	if err != nil {
		forwardError(w, err)
		return
	}

	if allConfirmed {
		statusUpdate := map[string]string{"status": "equipment_checked"}
		if _, err := bookingRequest("PATCH", "/moves/"+moveID+"/status", tenant, statusUpdate); err != nil {
			forwardError(w, err)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"move_id":       moveID,
		"item":          item,
		"all_confirmed": allConfirmed,
		"checklist":     checklist,
	})
}

func checklistComplete(moveID, tenant string) (bool, []checklistItem, error) {
	body, err := bookingRequest("GET", "/moves/"+moveID+"/checklist", tenant, nil)
	if err != nil {
		return false, nil, err
	}
	var items []checklistItem
	if err := json.Unmarshal(body, &items); err != nil {
		return false, nil, err
	}
	if len(items) == 0 {
		return false, items, nil
	}
	for _, it := range items {
		if !it.Confirmed {
			return false, items, nil
		}
	}
	return true, items, nil
}

// --- Clock in / out — gated on equipment checklist ----------------------

type clockRequest struct {
	MoverID string `json:"mover_id"`
}

type moveRecord struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func handleClockIn(w http.ResponseWriter, r *http.Request, moveID string) {
	tenant, ok := tenantID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "x-clarity-tenant-id header is required")
		return
	}
	var req clockRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MoverID == "" {
		writeError(w, http.StatusBadRequest, "mover_id is required")
		return
	}

	complete, _, err := checklistComplete(moveID, tenant)
	if err != nil {
		forwardError(w, err)
		return
	}
	if !complete {
		writeError(w, http.StatusConflict, "equipment checklist is not fully confirmed — clock-in blocked")
		return
	}

	clockBody := map[string]string{"mover_id": req.MoverID, "event_type": "clock_in"}
	if _, err := bookingRequest("POST", "/moves/"+moveID+"/clock", tenant, clockBody); err != nil {
		forwardError(w, err)
		return
	}

	statusUpdate := map[string]string{"status": "in_progress"}
	if _, err := bookingRequest("PATCH", "/moves/"+moveID+"/status", tenant, statusUpdate); err != nil {
		forwardError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"move_id": moveID, "mover_id": req.MoverID, "status": "in_progress"})
}

func handleClockOut(w http.ResponseWriter, r *http.Request, moveID string) {
	tenant, ok := tenantID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "x-clarity-tenant-id header is required")
		return
	}
	var req clockRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MoverID == "" {
		writeError(w, http.StatusBadRequest, "mover_id is required")
		return
	}

	clockBody := map[string]string{"mover_id": req.MoverID, "event_type": "clock_out"}
	if _, err := bookingRequest("POST", "/moves/"+moveID+"/clock", tenant, clockBody); err != nil {
		forwardError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"move_id": moveID, "mover_id": req.MoverID, "status": "clocked_out"})
}

func handleJobStatus(w http.ResponseWriter, r *http.Request, moveID string) {
	tenant, ok := tenantID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "x-clarity-tenant-id header is required")
		return
	}
	moveBody, err := bookingRequest("GET", "/moves/"+moveID, tenant, nil)
	if err != nil {
		forwardError(w, err)
		return
	}
	var move json.RawMessage = moveBody

	_, checklist, err := checklistComplete(moveID, tenant)
	if err != nil {
		forwardError(w, err)
		return
	}

	assignmentsBody, err := bookingRequest("GET", "/moves/"+moveID+"/assignments", tenant, nil)
	if err != nil {
		forwardError(w, err)
		return
	}
	var assignments []map[string]interface{}
	_ = json.Unmarshal(assignmentsBody, &assignments)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"move":        move,
		"checklist":   checklist,
		"assignments": assignments,
	})
}

func forwardError(w http.ResponseWriter, err error) {
	if apiErr, ok := err.(*apiError); ok {
		writeError(w, apiErr.Status, apiErr.Body)
		return
	}
	log.Printf("[ops-service] upstream call failed: %v", err)
	writeError(w, http.StatusBadGateway, "upstream booking-service call failed")
}

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"ok": "true", "service": "ops-service"})
	})

	mux.HandleFunc("/jobs/", func(w http.ResponseWriter, r *http.Request) {
		// Path shapes:
		//   /jobs/{moveId}/assign
		//   /jobs/{moveId}/checklist/{item}/confirm
		//   /jobs/{moveId}/clock-in
		//   /jobs/{moveId}/clock-out
		//   /jobs/{moveId}/status
		path := r.URL.Path[len("/jobs/"):]
		segments := splitPath(path)

		if len(segments) == 2 && segments[1] == "assign" && r.Method == http.MethodPost {
			handleAssign(w, r, segments[0])
			return
		}
		if len(segments) == 4 && segments[1] == "checklist" && segments[3] == "confirm" && r.Method == http.MethodPost {
			handleChecklistConfirm(w, r, segments[0], segments[2])
			return
		}
		if len(segments) == 2 && segments[1] == "clock-in" && r.Method == http.MethodPost {
			handleClockIn(w, r, segments[0])
			return
		}
		if len(segments) == 2 && segments[1] == "clock-out" && r.Method == http.MethodPost {
			handleClockOut(w, r, segments[0])
			return
		}
		if len(segments) == 2 && segments[1] == "status" && r.Method == http.MethodGet {
			handleJobStatus(w, r, segments[0])
			return
		}

		writeError(w, http.StatusNotFound, "no matching ops-service route")
	})

	port := envOr("PORT", "4002")
	log.Printf("[ops-service] listening on %s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

func splitPath(path string) []string {
	var segments []string
	start := 0
	for i := 0; i <= len(path); i++ {
		if i == len(path) || path[i] == '/' {
			if i > start {
				segments = append(segments, path[start:i])
			}
			start = i + 1
		}
	}
	return segments
}
